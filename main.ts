import { App, Editor, EditorRange, Modal, normalizePath, Notice, Plugin, PluginSettingTab, requestUrl, RequestUrlResponse, Setting, TFolder, TFile } from 'obsidian';
import { escapeRegExp } from 'lodash';

interface PluginSettings {
	paperlessUrl: string;
	paperlessAuthToken: string;
	documentStoragePath: string;
	embedDocuments: boolean;
}

interface PaperlessInsertionData {
	documentId: string;
	range: EditorRange;
}

type FileVersion = 'archive' | 'original';

// Which file version a fresh share link should point at.
// 'archive' is the paperless-ngx default and always yields a PDF that
// Obsidian/PDF++ can render; 'original' keeps upstream's old behaviour.
const DEFAULT_SHARE_FILE_VERSION: FileVersion = 'archive';

const DEFAULT_SETTINGS: PluginSettings = {
	paperlessUrl: '',
	paperlessAuthToken: '',
	documentStoragePath: '',
	embedDocuments: true
}

export default class ObsidianPaperless extends Plugin {
	settings: PluginSettings;

	async onload() {
		await this.loadSettings();

		this.addCommand({
			id: 'insert-from-paperless',
			name: 'Insert document',
			editorCallback: (editor: Editor) => {
				new DocumentSelectorModal(this.app, editor, this.settings).open();
			}
		});

		this.addCommand({
			id: 'insert-from-paperless-in-current-folder',
			name: 'Insert document in current folder',
			editorCallback: (editor: Editor) => {
				const activeFile = this.app.workspace.getActiveFile();
				if (!activeFile) {
					new Notice('Open a note before inserting a Paperless document.');
					return;
				}
				new DocumentSelectorModal(this.app, editor, this.settings, 'embed', activeFile.parent?.path ?? '', true).open();
			}
		});

		this.addCommand({
			id: 'insert-link-from-paperless',
			name: 'Insert document link',
			editorCallback: (editor: Editor) => {
				new DocumentSelectorModal(this.app, editor, this.settings, 'link').open();
			}
		});

		this.addCommand({
			id: 'replace-with-paperless',
			name: 'Replace URL with document',
			editorCallback: (editor: Editor) => {
				const paperlessUrl = searchPaperlessUrl(editor, this.settings);
				if (paperlessUrl) {
					createDocument(this.app, editor, this.settings, paperlessUrl);
				}
			}
		});

		this.addCommand({
			id: 'force-refresh-cache',
			name: 'Refresh document cache',
			callback: () => {
				new Notice('Refreshing paperless cache.');
				// a refresh that cannot reach paperless becomes an unhandled
				// promise rejection and the user sees only "Refreshing...".
				refreshCacheFromPaperless(this.settings, false).catch((error) => {
					new Notice('Failed to refresh cache: ' + (error && error.message ? error.message : error));
					console.error('Paperless refresh failed:', error);
				});
			}
		});

		this.addCommand({
			id: 'import-missing-paperless',
			name: 'Import missing documents',
			editorCallback: async (editor: Editor) => {
				await importMissingDocuments(this.app, editor, this.settings);
			}
		});

		this.addSettingTab(new SettingTab(this.app, this));
	}

	onunload() {}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

const documentCache = new Map<string, Record<string, any>>();
const tagCache = new Map<number, Record<string, any>>();

// Ids of every cached document, in the order paperless returned them.
let cachedDocumentIds: string[] = [];

// True once documents have been fetched successfully, so opening the modal does
// not re-request them every time. A failed load leaves this false and is retried.
let cacheLoaded = false;

// Non-fatal problems from the last cache refresh, surfaced in the notice.
let refreshWarnings: string[] = [];

// paperless-ngx defaults to 25 results per page; ask for full pages instead.
const PAGE_SIZE = '100';
// Safety stop so a misbehaving "next" chain cannot loop forever.
const MAX_PAGES = 50;

// PDF++ only treats a note as an external pdf ("dummy pdf file") when the file
// holds a single URL and stays within this size, so a .pdf extension is only
// safe to use when the share link we write fits.
// See https://ryotaushio.github.io/obsidian-pdf-plus/external-pdf-files.html
const DUMMY_FILE_MAX_BYTES = 300;

/// Request headers for the paperless API.
function authHeaders(settings: PluginSettings, headers: Record<string, string> = {}): Record<string, string> {
	return Object.assign({'Authorization': 'token ' + settings.paperlessAuthToken}, headers);
}

/// Build the URL for a given page, keeping every other query parameter.
/// Pages are derived from the URL we were configured with instead of the
/// server's "next" link: behind a reverse proxy paperless can build "next" from
/// a host that is only reachable inside the docker network, which the plugin
/// cannot connect to (ERR_CONNECTION_REFUSED), and it can also downgrade https
/// to http. Deriving the page URL ourselves keeps every request on the
/// configured address.
function pageUrl(url: string, page: number): string {
	const u = new URL(url);
	u.searchParams.set('page', String(page));
	return u.toString();
}

/// Items from a paginated response: "results" (api version >= 10) or the legacy
/// "all" id list on older instances.
function extractItems(body: any): any[] {
	if (!body) {
		return [];
	}
	if (Array.isArray(body['results'])) {
		return body['results'];
	}
	if (Array.isArray(body['all'])) {
		return body['all'];
	}
	return [];
}

/// Fetch every item of a paginated paperless endpoint. Stops when the reported
/// count is reached, so nothing is silently capped at the default 25 per page.
async function fetchAllResults(settings: PluginSettings, url: string, headers: Record<string, string> = {}, what = 'results'): Promise<any[]> {
	const first: RequestUrlResponse = await requestUrl({url: url, headers: authHeaders(settings, headers)});
	if (first.status != 200) {
		throw new Error('paperless returned status ' + first.status + ' for ' + url);
	}

	const body: any = first.json;
	if (Array.isArray(body)) {
		// Unpaginated endpoint
		return body.slice();
	}

	let items = extractItems(body);
	const count = typeof body['count'] === 'number' ? body['count'] : items.length;

	for (let page = 2; items.length < count && page <= MAX_PAGES; page++) {
		const result: RequestUrlResponse = await requestUrl({url: pageUrl(url, page), headers: authHeaders(settings, headers)});
		if (result.status != 200) {
			throw new Error('paperless returned status ' + result.status + ' for page ' + page + ' of ' + what);
		}
		const more = extractItems(result.json);
		if (more.length === 0) {
			break;
		}
		items = items.concat(more);
	}

	return items;
}

/// Newest first, matching upstream's ordering. Defensive about its input so an
/// empty or partially populated cache can never throw.
function sortDocumentIds(ids: string[] | null | undefined): string[] {
	return (ids || []).slice().sort((a, b) => {return +a - +b}).reverse();
}

async function testConnection(settings: PluginSettings) {
	new Notice("Testing connection to " + settings.paperlessUrl)
	const url = new URL(settings.paperlessUrl + '/api/documents/');
	try {
		const result = await requestUrl({
			url: url.toString(),
			headers: {
				'Authorization': 'token ' + settings.paperlessAuthToken
			}
		})
		if (result.status == 200 && result.json['results']) {
			new Notice("Connection successful")
		}
	} catch(exception) {
		new Notice("Failed to connect to " + settings.paperlessUrl + " - check the console for additional information.")
		console.log("Failed connection to " + url + " with error: " + exception)
	}
}

async function refreshCacheFromPaperless(settings: PluginSettings, silent=true) {
	refreshWarnings = [];
	// Documents: paginated since paperless-ngx 0.x. Fetch every page and read
	// ids from "results" (api version >= 10) or the legacy "all" id list.
	const docUrl = settings.paperlessUrl + '/api/documents/?format=json&page_size=' + PAGE_SIZE;
	const documents = await fetchAllResults(settings, docUrl, {}, 'documents');
	cachedDocumentIds = documents.map((d) => String(typeof d === 'object' && d ? d['id'] : d));
	documentCache.clear();
	for (const document of documents) {
		if (document && typeof document === 'object' && document['id'] !== undefined) {
			documentCache.set(String(document['id']), document);
		}
	}
	cacheLoaded = true;

	// Cache data relating to tags. No "version" is pinned here: pinning a fixed
	// version breaks the request on newer paperless builds, whose allowed
	// versions moved past the pinned one (issue #33), while omitting the header
	// lets DRF fall back to the instance default, which works on old and new.
	// A failure here must not report the whole refresh as failed: documents are
	// already cached, and tag filtering is a secondary feature. Keep whatever
	// tags were cached before rather than clearing them.
	const tagUrl = settings.paperlessUrl + '/api/tags/?format=json&page_size=' + PAGE_SIZE;
	try {
		const tags = await fetchAllResults(settings, tagUrl, {}, 'tags');
		if (tags.length > 0) {
			tagCache.clear();
			for (let current of tags) {
				if (current && current['id'] !== undefined) {
					tagCache.set(current['id'], current);
				}
			}
		}
	} catch (error) {
		console.error('Paperless: fetching tags failed, keeping any cached tags:', error);
		refreshWarnings.push('tags could not be loaded (' + (error && error.message ? error.message : error) + ')');
	}
	if(!silent) {
		const suffix = refreshWarnings.length > 0 ? ' (' + refreshWarnings.join('; ') + ')' : '';
		new Notice('Paperless cache refresh completed. Found ' + cachedDocumentIds.length + ' documents and ' + tagCache.size + ' tags.' + suffix);
	}
}

/// Find the word under the cursor (we can't use editor.wordAt because we want everything between two whitespace characters)
function wordAtCursor(editor: Editor): EditorRange | null {
	const cursor = editor.getCursor();
	const line = editor.getLine(cursor.line);

	const wordRegex = /\S+/g;
	let match: RegExpExecArray | null;

	while ((match = wordRegex.exec(line)) !== null) {
		const start = match.index;
		const end = start + match[0].length;
		if (cursor.ch >= start && cursor.ch <= end) {
			return {
				from: { line: cursor.line, ch: start },
				to: { line: cursor.line, ch: end }
			};
		}
	}

	return null;
}

/// Search the Paperless URL from selection / cursor position
function searchPaperlessUrl(editor: Editor, settings: PluginSettings): PaperlessInsertionData | null {
	const wordRange = wordAtCursor(editor);
	if (wordRange === null) {
		return null;
	}

	const text = editor.getRange(wordRange.from, wordRange.to)

	// find documentId in the selection using a regex
	const normalizedUrl = new URL(settings.paperlessUrl).toString();
	const quotedUrl = escapeRegExp(normalizedUrl);
	const urlVariants = [
		`${quotedUrl}api/documents/(\\d+)/preview`,
		`${quotedUrl}documents/(\\d+)/details`
	];

	// find a matching URL variant
	for (const regex of urlVariants) {
		console.log("Regex: " + regex);
		const match = text.match(regex);
		if (match) {
			return {
				documentId: match[1],
				range: wordRange
			};
		}
	}

	// also match [[paperless-{id}.pdf]] wiki links
	const wikiLinkMatch = text.match(/\[\[paperless-(\d+)\.pdf\]\]/);
	if (wikiLinkMatch) {
		return {
			documentId: wikiLinkMatch[1],
			range: wordRange
		};
	}

	// nothing found
	return null;
}

function fileVersionLabel(version: FileVersion): string {
	return version === 'archive' ? 'archived PDF' : 'original file';
}

interface VersionChoice {
	version: FileVersion;
	hasArchive: boolean;
	originalName: string | null;
	archivedName: string | null;
}

/// Look up a document's metadata. Returns null if it cannot be read.
async function fetchDocumentInfo(settings: PluginSettings, documentId: string): Promise<any | null> {
	const url = new URL(settings.paperlessUrl + '/api/documents/' + documentId + '/?format=json');
	try {
		const result = await requestUrl({
			url: url.toString(),
			headers: {
				'Authorization': 'token ' + settings.paperlessAuthToken
			}
		})
		if (result.status != 200) {
			console.error("An exception occurred in fetchDocumentInfo. Response: " + result);
			return null;
		}
		return result.json;
	} catch (e) {
		console.error("An exception occurred in fetchDocumentInfo. Exception: " + e);
		return null;
	}
}

/// Decide which file version should be used for a document.
/// Prefers the archived version, which paperless-ngx always stores as a pdf, so
/// documents whose original is not a pdf (docx, odt, images, ...) can still be
/// displayed by Obsidian. Falls back to the original file when there is no
/// archive to use.
async function resolveFileVersion(settings: PluginSettings, documentId: string): Promise<VersionChoice> {
	const doc = await fetchDocumentInfo(settings, documentId);
	if (doc === null) {
		// Metadata unreadable (permission, transient error, very old instance).
		// Trust the paperless default rather than forcing "original".
		return {version: DEFAULT_SHARE_FILE_VERSION, hasArchive: false, originalName: null, archivedName: null};
	}

	const originalName: string | null = doc['original_file_name'] || null;
	const archivedName: string | null = doc['archived_file_name'] || null;

	if (archivedName && (!originalName || archivedName != originalName)) {
		// A separate archived version exists, i.e. the original is not a pdf.
		return {version: 'archive', hasArchive: true, originalName, archivedName};
	}

	return {version: 'original', hasArchive: !!archivedName, originalName, archivedName};
}

/// Find the share link we previously created for this document version.
/// file_version is part of the share link API since paperless-ngx 2.0; on older
/// instances the field is absent and can only be matched loosely.
function shareLinkItems(json: any): any[] {
	if (Array.isArray(json)) {
		return json;
	}
	if (json && Array.isArray(json['results'])) {
		return json['results'];
	}
	return [];
}

function findExistingLink(json: any, version: FileVersion) {
	const items = shareLinkItems(json);

	for (let item of items) {
		if (item['expiration'] == null && item['file_version'] === version) {
			return item;
		}
	}

	// Instances predating the file_version field served share links from the
	// original file, so such a link is only a valid match for that version.
	if (version === 'original') {
		for (let item of items) {
			if (item['expiration'] == null && item['file_version'] === undefined) {
				return item;
			}
		}
	}

	return null;
}

function makeShareUrl(settings: PluginSettings, slug: string): URL {
	return new URL(settings.paperlessUrl + '/share/' + slug);
}

async function getExistingShareLink(settings: PluginSettings, documentId: string, fileVersion: FileVersion = DEFAULT_SHARE_FILE_VERSION): Promise<{url: URL, fileVersion: FileVersion} | null> {
	const url = new URL(settings.paperlessUrl + '/api/documents/' + documentId + '/share_links/?format=json');
	let result;
	try {
		result = await requestUrl({
			url: url.toString(),
			headers: {
				'Authorization': 'token ' + settings.paperlessAuthToken
			}
		})
		if (result.status != 200) {
			console.error("An exception occurred in getExistingShareLink. Response: " + result);
			return null;
		}
		let item = findExistingLink(result.json, fileVersion);
		if (item) {
			return {url: makeShareUrl(settings, item['slug']), fileVersion: fileVersion};
		}
	} catch (e) {
		console.error("An exception occurred in getExistingShareLink. Exception: " + e + " and response " + result);
	}

	return null;
}

async function createShareLink(settings: PluginSettings, documentId: string, fileVersion: FileVersion = DEFAULT_SHARE_FILE_VERSION) {
	const url = new URL(settings.paperlessUrl + '/api/share_links/');
	let result;
	try {
		result = await requestUrl({
			url: url.toString(),
			method: 'POST',
			contentType: 'application/json',
			body: JSON.stringify({ document: documentId, file_version: fileVersion }),
			headers: {
				'Authorization': 'token ' + settings.paperlessAuthToken
			}
		})
		if (result.status === 201 && result.json['slug']) {
			return result.json['slug'];
		}
	} catch (e) {
		console.error("An exception occurred in createShareLink. Exception: " + e + " and response " + result);
	}

	return null;
}

async function getShareLink(settings: PluginSettings, documentId: string, fileVersion: FileVersion = DEFAULT_SHARE_FILE_VERSION) {
	let link = await getExistingShareLink(settings, documentId, fileVersion);
	if (!link) {
		await createShareLink(settings, documentId, fileVersion);
		link = await getExistingShareLink(settings, documentId, fileVersion);
		if (link == null) {
			// Sometimes this takes a while, give it five immediate retries before giving up.
			for (let i = 0; i < 5; i++) {
				link = await getExistingShareLink(settings, documentId, fileVersion);
				if (link) {
					break;
				}
			}
		}
	}
	return link;
}

/// Resolve a share link that Obsidian can actually display: prefer the archived
/// pdf version and fall back to the original file only when the archive cannot
/// be used.
async function resolveShareLink(settings: PluginSettings, documentId: string) {
	const choice = await resolveFileVersion(settings, documentId);
	const fallback: FileVersion = choice.version === 'archive' ? 'original' : 'archive';

	let link = await getShareLink(settings, documentId, choice.version);
	if (!link) {
		console.log("Paperless: falling back to the " + fileVersionLabel(fallback) + " for document " + documentId);
		link = await getShareLink(settings, documentId, fallback);
	}

	if (!link) {
		return null;
	}

	// Decide the extension from what the link will actually serve. "An archive
	// exists" is NOT the same question as "a pdf will be served": a document that
	// was uploaded as a pdf often has no separate archived version at all
	// (paperless skips archiving when the original is already pdf/a), and in that
	// case the original *is* a pdf. Getting this wrong names a pdf-backed note
	// .share.md, and a .md note holding a URL is not a PDF++ dummy file, so
	// Obsidian just shows a link that opens in the browser.
	const servedVersion: FileVersion = link.fileVersion;
	const originalName: string | null = choice.originalName;
	const servesArchive = servedVersion === 'archive';
	const originalIsPdf = /\.pdf$/i.test(originalName || '');
	const servesPdf = servesArchive || originalIsPdf;

	// PDF++ treats a note as an external pdf only when the file holds a single
	// URL within DUMMY_FILE_MAX_BYTES, so the .pdf name is only safe to use when
	// the payload we are about to write actually qualifies.
	const payload = link.url.href;
	const withinPdfPlusLimit = payload.length <= DUMMY_FILE_MAX_BYTES;

	return {
		url: link.url,
		version: servedVersion,
		servesPdf: servesPdf,
		usePdfName: servesPdf && withinPdfPlusLimit,
		payloadLength: payload.length,
	};
}

function createDocumentFilename(documentId: string, extension: string, customName?: string): string {
	const name = customName?.trim();
	if (!name) {
		return 'paperless-' + documentId + extension;
	}
	if (name === '.' || name === '..' || /[\\/:*?"<>|#[\]^]/.test(name)) {
		throw new Error('The custom document name contains invalid characters');
	}
	return name.replace(/\.(pdf|share\.md)$/i, '') + extension;
}

async function ensureDocumentFile(app: App, settings: PluginSettings, documentId: string, folder?: string, customName?: string): Promise<string> {
	const folderPath = normalizePath(folder ?? settings.documentStoragePath).replace(/^\/+/, '');
	if (folderPath && !(app.vault.getAbstractFileByPath(folderPath) instanceof TFolder)) {
		await app.vault.createFolder(folderPath);
	}
	const link = await resolveShareLink(settings, documentId);
	if (!link) throw new Error('No usable share link found');
	const filename = createDocumentFilename(documentId, link.usePdfName ? '.pdf' : '.share.md', customName);
	const documentPath = folderPath ? folderPath + '/' + filename : filename;
	const existingFile = app.vault.getAbstractFileByPath(documentPath);
	if (existingFile instanceof TFile && customName?.trim()) {
		throw new Error('A file with that custom name already exists');
	}
	if (!(existingFile instanceof TFile)) {
		await app.vault.create(documentPath, link.url.href);
	}
	return filename;
}

async function createDocument(
	app: App,
	editor: Editor,
	settings: PluginSettings,
	paperlessUrl: PaperlessInsertionData,
	folderPath?: string,
	customName?: string
): Promise<boolean> {
	try {
		const filename = await ensureDocumentFile(app, settings, paperlessUrl.documentId, folderPath, customName);
		const linkPrefix = settings.embedDocuments && filename.endsWith('.pdf') ? '![' : '[';
		editor.replaceRange(linkPrefix + '[' + filename + ']]', paperlessUrl.range.from, paperlessUrl.range.to);
		return true;
	} catch (error) {
		console.error('Failed to create Paperless document:', error);
		new Notice('Failed to import Paperless document.');
		return false;
	}
}

async function importMissingDocuments(app: App, editor: Editor, settings: PluginSettings) {
	const documentIds = new Set<string>();
	for (const match of editor.getValue().matchAll(/!?\[\[paperless-(\d+)\.pdf\]\]/g)) {
		documentIds.add(match[1]);
	}
	if (documentIds.size === 0) {
		new Notice('No paperless document links found in this note.');
		return;
	}
	let importedCount = 0;
	let failedCount = 0;
	for (const documentId of documentIds) {
		try {
			await ensureDocumentFile(app, settings, documentId);
			importedCount++;
		} catch (error) {
			failedCount++;
			console.error('Failed to import Paperless document ' + documentId + ':', error);
		}
	}
	new Notice(`Imported ${importedCount} of ${documentIds.size} document(s).${failedCount ? ` Failed: ${failedCount}.` : ''}`);
}

async function insertDocumentLink(editor: Editor, settings: PluginSettings, documentId: string) {
	const url = new URL(settings.paperlessUrl + '/api/documents/' + documentId + '/');
	const cursor = editor.getCursor();
	let title = 'Document ' + documentId;
	try {
		const result = await requestUrl({
			url: url.toString(),
			headers: { 'Authorization': 'token ' + settings.paperlessAuthToken }
		});
		if (result.status === 200 && result.json['title']) {
			title = result.json['title'];
		}
	} catch (e) {
		console.error('Failed to fetch document title:', e);
	}
	const detailUrl = new URL(settings.paperlessUrl + '/documents/' + documentId + '/details');
	editor.replaceRange('[' + title + '](' + detailUrl.href + ')', cursor, cursor);
}

async function searchPaperlessDocuments(settings: PluginSettings, searchQuery: string, tagIds: number[] = []): Promise<string[]> {
	let urlStr = settings.paperlessUrl + '/api/documents/?format=json&page_size=' + PAGE_SIZE;
	if (searchQuery) {
		urlStr += '&text=' + encodeURIComponent(searchQuery);
	}
	if (tagIds.length > 0) {
		urlStr += '&tags__id__all=' + tagIds.join(',');
	}
	console.log("Querying " + urlStr)
	const url = new URL(urlStr);
	try {
		const documents = await fetchAllResults(settings, url.toString(), {}, 'search results');
		return documents.map((d) => String(typeof d === 'object' && d ? d['id'] : d));
	} catch (error) {
		console.error('Error searching Paperless:', error);
		throw error;
	}
}

class DocumentNameModal extends Modal {
	private resolveName: ((name: string | null) => void) | null = null;

	getName(): Promise<string | null> {
		return new Promise((resolve) => {
			this.resolveName = resolve;
			this.open();
		});
	}

	onOpen() {
		this.titleEl.setText('Name document');
		const input = this.contentEl.createEl('input', {
			type: 'text',
			placeholder: 'Optional custom name'
		});
		input.focus();

		const buttons = this.contentEl.createDiv();
		const insertButton = buttons.createEl('button', { text: 'Insert' });
		const finish = (name: string | null) => {
			this.resolveName?.(name);
			this.resolveName = null;
			this.close();
		};

		insertButton.onclick = () => finish(input.value);
		input.addEventListener('keydown', (event) => {
			if (event.key === 'Enter') {
				finish(input.value);
			}
		});
	}

	onClose() {
		this.contentEl.empty();
		this.resolveName?.(null);
		this.resolveName = null;
	}
}

class DocumentSelectorModal extends Modal {
	editor: Editor;
	settings: PluginSettings;
	mode: 'embed' | 'link';
	folderPath: string | undefined;
	promptForCustomName: boolean;
	currentPage: number;
	batchSize: number;
	loadedAssets: Map<number, HTMLElement>;
	scrollContainer: HTMLElement | null;
	isLoading: boolean;
	scrollTimeout: number | null;
	searchTimeout: number | null;
	searchGeneration: number;
	selectedTags: Set<number>;
	availableDocumentIds: string[];
	closeDropdownHandler: ((e: Event) => void) | null;

	constructor(app: App, editor: Editor, settings: PluginSettings, mode: 'embed' | 'link' = 'embed', folderPath?: string, promptForCustomName = false) {
		super(app);
		this.editor = editor;
		this.settings = settings;
		this.mode = mode;
		this.folderPath = folderPath;
		this.promptForCustomName = promptForCustomName;
		this.currentPage = 0;
		this.batchSize = 6;
		this.loadedAssets = new Map();
		this.scrollContainer = null;
		this.isLoading = false;
		this.scrollTimeout = null;
		this.searchTimeout = null;
		this.searchGeneration = 0;
		this.selectedTags = new Set();
		this.availableDocumentIds = [];
		this.closeDropdownHandler = null;
	}

	async displayThumbnail(imgElement: HTMLImageElement, documentId: string) {
		const thumbUrl = this.settings.paperlessUrl + '/api/documents/' + documentId + '/thumb/';
		const result = await requestUrl({
			url: thumbUrl.toString(),
			headers: {
				'Authorization': 'token ' + this.settings.paperlessAuthToken
			}
		})
		imgElement.src = URL.createObjectURL(new Blob([result.arrayBuffer]));
	}

	async displayTags(tagDiv: HTMLDivElement, documentId: string) {
		let tags = documentCache.get(documentId)?.tags;
		if (!Array.isArray(tags)) {
			try {
				const result = await requestUrl({
					url: this.settings.paperlessUrl + '/api/documents/' + documentId + '/',
					headers: {'Authorization': 'token ' + this.settings.paperlessAuthToken}
				});
				if (result.status === 200) {
					documentCache.set(documentId, result.json);
					tags = result.json['tags'];
				}
			} catch (error) {
				console.error('Failed to fetch tags for Paperless document ' + documentId + ':', error);
			}
		}
		if (!Array.isArray(tags)) {
			console.warn('No cached tags found for Paperless document ' + documentId);
			return;
		}
		for (let x = 0; x < tags.length; x++) {
			const currentTag = tagDiv.createDiv();
			const tagData = tagCache.get(tags[x]);
			if (!tagData) {
				continue;
			}
			const tagStr = currentTag.createEl('span', {text: tagData['name']});
			tagStr.setCssStyles({color: tagData['text_color'], fontSize: '0.7em'});
			currentTag.setCssStyles({background: tagData['color'], borderRadius: '8px', padding: '2px', marginTop: '1px', marginRight: '5px'})
		}
	}

	async onOpen() {
		const {contentEl} = this;
		if (!cacheLoaded) {
			try {
				await refreshCacheFromPaperless(this.settings);
			} catch (error) {
				console.error('Paperless: initial cache load failed:', error);
				new Notice('Paperless: could not load documents. ' +
					(error && error.message ? error.message : error) +
					' Use the refresh button to retry.');
			}
		}

		// Create header with title and refresh button
		const header = contentEl.createDiv({cls: 'obsidian-paperless-header'});

		const titleDiv = header.createDiv({cls: 'obsidian-paperless-title'});
		titleDiv.setText(this.mode === 'link' ? 'Insert document link' : 'Insert document');

		// Search box in header
		const searchInput = header.createEl('input', {
			type: 'text',
			placeholder: 'Search documents...',
			cls: 'obsidian-paperless-search-input'
		});

		// Tag filter button and dropdown
		const tagFilterContainer = header.createDiv({cls: 'obsidian-paperless-tag-filter'});

		const tagFilterButton = tagFilterContainer.createEl('button', {
			text: 'Tags',
			cls: 'obsidian-paperless-tag-button'
		});

		const tagDropdown = tagFilterContainer.createDiv({cls: 'obsidian-paperless-tag-dropdown'});

		// Populate tag dropdown
		const tags = Array.from(tagCache.entries())
			.filter(([, tagData]) => !!tagData && typeof tagData['name'] === 'string')
			.sort((a, b) => a[1]['name'].localeCompare(b[1]['name']));
		for (const [tagId, tagData] of tags) {
			const tagItem = tagDropdown.createDiv({cls: 'obsidian-paperless-tag-item'});

			const checkbox = tagItem.createEl('input', {type: 'checkbox'});

			const tagLabel = tagItem.createEl('span', {text: tagData['name']});
			tagLabel.style.color = tagData['text_color'];
			tagLabel.style.background = tagData['color'];

			const updateTagSelection = () => {
				if (checkbox.checked) {
					this.selectedTags.add(tagId);
				} else {
					this.selectedTags.delete(tagId);
				}
				// Update button text to show count
				tagFilterButton.setText(this.selectedTags.size > 0 ? `Tags (${this.selectedTags.size})` : 'Tags');
				// Close dropdown
				tagDropdown.style.display = 'none';
				// Trigger search with new tag filter
				searchInput.dispatchEvent(new Event('input'));
			};

			checkbox.onclick = (e) => {
				e.stopPropagation();
				updateTagSelection();
			};

			tagItem.onclick = (e) => {
				e.stopPropagation();
				checkbox.checked = !checkbox.checked;
				updateTagSelection();
			};
		}

		// instead of leaving the user staring at a silently empty dropdown
		if (tags.length === 0) {
			const emptyItem = tagDropdown.createDiv({cls: 'obsidian-paperless-tag-empty'});
			emptyItem.setText('No tags available');
		}

		// Toggle dropdown visibility. setCssStyles is used rather than a bare
		// style assignment because the stylesheet sets `display: none`.
		tagFilterButton.onclick = (e) => {
			e.stopPropagation();
			const isOpen = tagDropdown.style.display === 'block';
			tagDropdown.setCssStyles({display: isOpen ? 'none' : 'block'});
		};

		// Close dropdown when clicking outside. The dropdown lives inside
		// contentEl, so a listener on contentEl would also receive clicks from
		// the dropdown's own items and close it immediately. Listen on document
		// and stop the event at the dropdown instead. Modal is not a Component,
		// so the listener is removed manually in onClose().
		this.closeDropdownHandler = (e: Event) => {
			if (e.target && tagFilterContainer.contains(e.target as Node)) {
				return;
			}
			tagDropdown.setCssStyles({display: 'none'});
		};
		document.addEventListener('click', this.closeDropdownHandler);
		tagDropdown.addEventListener('click', (e) => e.stopPropagation());

		const refreshButton = header.createEl('button', {
			text: '\u21bb',
			cls: 'obsidian-paperless-refresh-button'
		});
		refreshButton.onclick = async () => {
			refreshButton.disabled = true;
			refreshButton.setText('Loading...');
			try {
				await refreshCacheFromPaperless(this.settings, false);
				// Reload the modal
				this.onClose();
				this.onOpen();
			} catch (error) {
				// message, so API failures are visible in the UI too
				new Notice('Failed to refresh cache: ' + (error && error.message ? error.message : error));
				console.error('Refresh failed:', error);
				refreshButton.disabled = false;
				refreshButton.setText('\u21bb Refresh');
			}
		};

		const totalWidth = contentEl.innerWidth;
		this.availableDocumentIds = sortDocumentIds(cachedDocumentIds);
		const totalAssets = this.availableDocumentIds.length;

		// Create scroll container
		this.scrollContainer = contentEl.createDiv({cls: 'obsidian-paperless-scroll-container'});
		this.scrollContainer.setAttribute('data-paperless-modal-content', 'true');
		this.scrollContainer.style.maxHeight = '70vh';
		this.scrollContainer.style.overflowY = 'auto';

		const row = this.scrollContainer.createDiv({cls: 'obsidian-paperless-row'});
		const leftColumn = row.createDiv({cls: 'obsidian-paperless-column'});
		const rightColumn = row.createDiv({cls: 'obsidian-paperless-column'});
		const left = leftColumn.createDiv({cls: 'obsidian-paperless-column-content'});
		const right = rightColumn.createDiv({cls: 'obsidian-paperless-column-content'});

		// Create loading indicator inside scroll container
		const loadingDiv = this.scrollContainer.createDiv({cls: 'obsidian-paperless-loading'});
		loadingDiv.setText(`Showing ${Math.min(Math.max(this.batchSize * 3, 20), totalAssets)} of ${totalAssets} documents. Scroll to load more.`);
		loadingDiv.style.display = 'none';

		searchInput.addEventListener('input', async (e) => {
			const requestId = ++this.searchGeneration;
			if (this.searchTimeout) {
				clearTimeout(this.searchTimeout);
			}

			// Debounce: wait 500ms after user stops typing
			this.searchTimeout = window.setTimeout(async () => {
				if (requestId !== this.searchGeneration) return;
				const searchQuery = (e.target as HTMLInputElement).value.trim();

			if (searchQuery === '' && this.selectedTags.size === 0) {
				// Reset to cached results
				this.availableDocumentIds = sortDocumentIds(cachedDocumentIds);
			} else {
				// Perform search
				// focus after each keystroke (issue #33)
				loadingDiv.setText('Searching...');
				loadingDiv.style.display = 'block';

				try {
					const tagIds = Array.from(this.selectedTags);
					const searchResults = await searchPaperlessDocuments(this.settings, searchQuery, tagIds);
					if (requestId !== this.searchGeneration) return;
					this.availableDocumentIds = sortDocumentIds(searchResults);
				} catch (error) {
					if (requestId !== this.searchGeneration) return;
					new Notice('Failed to search documents');
					console.error('Search failed:', error);
					loadingDiv.style.display = 'none';
				} finally {
					loadingDiv.style.display = 'none';
				}
			}
				this.currentPage = 0;
				this.loadedAssets.clear();
				left.empty();
				right.empty();

				// Scroll to top
				if (this.scrollContainer) {
					this.scrollContainer.scrollTop = 0;
				}

			// Initial load: load more items to ensure scrollbar appears on large screens
			const initialBatchSize = Math.max(this.batchSize * 3, 20);
			this.loadBatch(left, right, totalWidth, this.availableDocumentIds, 0, Math.min(initialBatchSize, this.availableDocumentIds.length), loadingDiv);
			}, 500);
		});

		// Setup scroll listener with throttling
		this.setupScrollListener(left, right, totalWidth, loadingDiv);

		// Initial load: load more items to ensure scrollbar appears on large screens
		const initialBatchSize = Math.max(this.batchSize * 3, 20); // Load at least 20 items initially
		this.loadBatch(left, right, totalWidth, this.availableDocumentIds, 0, Math.min(initialBatchSize, totalAssets), loadingDiv);

	}

	private setupScrollListener(left: HTMLElement, right: HTMLElement, totalWidth: number, loadingDiv: HTMLElement) {
		if (!this.scrollContainer) return;

		this.scrollContainer.addEventListener('scroll', () => {
			if (this.scrollTimeout) {
				clearTimeout(this.scrollTimeout);
			}

			this.scrollTimeout = window.setTimeout(() => {
				this.checkAndLoadMore(left, right, totalWidth, loadingDiv);
			}, 150); // Throttle to 150ms
		});
	}

	private checkAndLoadMore(left: HTMLElement, right: HTMLElement, totalWidth: number, loadingDiv: HTMLElement) {
		if (!this.scrollContainer || this.isLoading || this.currentPage >= this.availableDocumentIds.length) {
			return;
		}

		const scrollTop = this.scrollContainer.scrollTop;
		const scrollHeight = this.scrollContainer.scrollHeight;
		const clientHeight = this.scrollContainer.clientHeight;
		const scrollPercentage = (scrollTop + clientHeight) / scrollHeight;

		// Load more when user scrolls past 60% or when near bottom
		if (scrollPercentage > 0.6 || (scrollHeight - (scrollTop + clientHeight) < 300)) {
			const endIndex = Math.min(this.currentPage + this.batchSize, this.availableDocumentIds.length);
			this.loadBatch(left, right, totalWidth, this.availableDocumentIds, this.currentPage, endIndex, loadingDiv);
		}
	}

	private loadBatch(left: HTMLElement, right: HTMLElement, totalWidth: number, availableDocumentIds: string[], startIndex: number, endIndex: number, loadingDiv: HTMLElement) {
		if (this.isLoading || startIndex >= availableDocumentIds.length) return;

		this.isLoading = true;
		loadingDiv.style.display = 'block';

		for (let i = startIndex; i < endIndex; i++) {
			if (this.loadedAssets.has(i)) continue;

			const documentId = availableDocumentIds[i];
			const targetColumn = (i & 1) ? right : left;
			const overallDiv = targetColumn.createDiv({cls: 'obsidian-paperless-overallDiv'});
			const imageDiv = overallDiv.createDiv({cls: 'obsidian-paperless-imageDiv'});
			const tagDiv = overallDiv.createDiv({cls: 'obsidian-paperless-tagDiv'});

			this.displayTags(tagDiv, documentId);

			const imgElement = imageDiv.createEl('img');
			imgElement.width = (totalWidth / 2) - 5;
			imgElement.style.cursor = 'pointer';

			imgElement.onclick = async () => {
				if (this.mode === 'link') {
					insertDocumentLink(this.editor, this.settings, documentId);
				} else {
					const customName = this.promptForCustomName
						? await new DocumentNameModal(this.app).getName()
						: '';
					if (customName === null) {
						return;
					}
					const cursor = this.editor.getCursor();
					const documentInfo: PaperlessInsertionData = {
						documentId: documentId,
						range: {
							from: { line: cursor.line, ch: cursor.ch },
							to: { line: cursor.line, ch: cursor.ch }
						}
					};

					const created = await createDocument(
						this.app,
						this.editor,
						this.settings,
						documentInfo,
						this.folderPath,
						customName
					);

					if (!created) {
						return;
					}
				}
				overallDiv.setCssStyles({ opacity: '0.5' });
			};
			imgElement.onerror = () => {
				overallDiv.setText('Failed to load');
			};

			this.displayThumbnail(imgElement, documentId).catch((error) => {
				console.error('Failed to load thumbnail for Paperless document ' + documentId + ':', error);
				overallDiv.setText('Failed to load');
			});
			this.loadedAssets.set(i, overallDiv);
		}

		this.currentPage = endIndex;
		loadingDiv.setText(`Showing ${endIndex} of ${availableDocumentIds.length} documents. Scroll to load more.`);

		setTimeout(() => {
			this.isLoading = false;
			if (endIndex >= availableDocumentIds.length) {
				loadingDiv.style.display = 'none';
			}
		}, 100);
	}

	onClose() {
		this.isLoading = false;
		this.scrollContainer = null;
		this.searchGeneration++;
		if (this.scrollTimeout) {
			clearTimeout(this.scrollTimeout);
		}
		if (this.searchTimeout) {
			clearTimeout(this.searchTimeout);
		}
		if (this.closeDropdownHandler) {
			document.removeEventListener('click', this.closeDropdownHandler);
			this.closeDropdownHandler = null;
		}
		this.loadedAssets.clear();
		const {contentEl} = this;
		contentEl.empty();
	}
}

class SettingTab extends PluginSettingTab {
	plugin: ObsidianPaperless;

	constructor(app: App, plugin: ObsidianPaperless) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;
		containerEl.empty();

		new Setting(containerEl)
		.setName('Paperless URL')
		.setDesc('Full URL to your paperless instance.')
		.addText(text => text
			.setValue(this.plugin.settings.paperlessUrl)
			.onChange(async (value) => {
				this.plugin.settings.paperlessUrl = value;
				await this.plugin.saveSettings();
			}));
		new Setting(containerEl)
			.setName('Paperless authentication token')
			.setDesc('Token obtained using https://docs.paperless-ngx.com/api/#authorization')
			.addText(text => text
				.setValue(this.plugin.settings.paperlessAuthToken)
				.onChange(async (value) => {
					this.plugin.settings.paperlessAuthToken = value;
					await this.plugin.saveSettings();
				})
				.inputEl.type = 'password');
		new Setting(containerEl)
			.setName('Document storage path')
			.setDesc('Location for stored documents.')
			.addText(text => text
				.setValue(this.plugin.settings.documentStoragePath)
				.onChange(async (value) => {
					this.plugin.settings.documentStoragePath = value;
					await this.plugin.saveSettings();
				}));
		new Setting(containerEl)
			.setName('Embed documents')
			.setDesc('When enabled, new documents are inserted as embedded PDFs (![[...]]). Otherwise as links ([[...]]).')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.embedDocuments)
				.onChange(async (value) => {
					this.plugin.settings.embedDocuments = value;
					await this.plugin.saveSettings();
				}));
		new Setting(containerEl)
			.setName('Test connection')
			.setDesc('Validate the connection between obsidian and your paperless instance.')
			.addButton(async (button) => {
				button.setButtonText("Test connection")
				button.onClick(async() => {
					testConnection(this.plugin.settings)
				})
			})
	}
}
