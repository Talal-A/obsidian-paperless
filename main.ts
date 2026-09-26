import { App, Editor, EditorRange, MarkdownView, Modal, normalizePath, Notice, Plugin, PluginSettingTab, requestUrl, RequestUrlResponse, Setting, setIcon, TFolder, TFile } from 'obsidian';
import { escapeRegExp } from 'lodash';

interface PluginSettings {
	paperlessUrl: string;
	paperlessAuthToken: string;
	documentStoragePath: string;
}

interface PaperlessInsertionData {
	documentId: string;
	range: EditorRange;
}

const DEFAULT_SETTINGS: PluginSettings = {
	paperlessUrl: '',
	paperlessAuthToken: '',
	documentStoragePath: ''
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
					createDocument(editor, this.settings, paperlessUrl);
				}
			}
		});

		this.addCommand({
			id: 'force-refresh-cache',
			name: 'Refresh document cache',
			callback: () => {
				new Notice('Refreshing paperless cache.');
				refreshCacheFromPaperless(this.settings, false);
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

let cachedResult: RequestUrlResponse;
let tagCache = new Map();

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
	const url = new URL(settings.paperlessUrl + '/api/documents/?format=json');
	const result = await requestUrl({
		url: url.toString(),
		headers: {
			'Authorization': 'token ' + settings.paperlessAuthToken
		}
	})
	cachedResult = result;

	// Cache data relating to tags
	const tagUrl = new URL(settings.paperlessUrl + '/api/tags/?format=json');
	const tagResult = await requestUrl({
		url: tagUrl.toString(),
		headers: {
			"accept": "application/json; version=5",
			'Authorization': 'token ' + settings.paperlessAuthToken
		}
	})
	for (let i = 0; i < tagResult.json['results'].length; i++) {
		let current = tagResult.json['results'][i];
		tagCache.set(current['id'], current);
	}
	if(!silent) {
		new Notice('Paperless cache refresh completed. Found ' + cachedResult.json['all'].length + ' documents and ' + tagCache.size + ' tags.');
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

	// nothing found
	return null;
}

async function getExistingShareLink(settings: PluginSettings, documentId: string) {
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
		for (let item of result.json) {
			if (item['expiration'] == null)  {
				return new URL(settings.paperlessUrl + '/share/' + item['slug']);
			}
		}
	} catch (e) {
		console.error("An exception occurred in getExistingShareLink. Exception: " + e + " and response " + result);
	}

	return null;
}

async function createShareLink(settings: PluginSettings, documentId: string) {
	const url = new URL(settings.paperlessUrl + '/api/share_links/');
	let result;
	try {
		result = await requestUrl({
			url: url.toString(),
			method: 'POST',
			contentType: 'application/json',
			body: '{"document":' + documentId + ',"file_version":"original"}',
			headers: {
				'Authorization': 'token ' + settings.paperlessAuthToken
			}
		})
		if (result.status != 201) {
			console.error("An exception occurred in createShareLink. Response: " + result);
		}
	} catch (e) {
		console.error("An exception occurred in createShareLink. Exception: " + e + " and response " + result);
	}
}

async function getShareLink(settings: PluginSettings, documentId: string) {
	let link = await getExistingShareLink(settings, documentId);
	if (!link) {
		createShareLink(settings, documentId);
		link = await getExistingShareLink(settings, documentId);
		if (link == null) {
			// Sometimes this takes a while, give it five immediate retries before giving up.
			for (let i = 0; i < 5; i++) {
				link = await getExistingShareLink(settings, documentId);
				if (link) {
					break;
				}
			}
		}
	}

	return link;
}

// Heavily inspired by https://github.com/RyotaUshio/obsidian-pdf-plus/blob/127ea5b94bb8f8fa0d4c66bcd77b3809caa50b21/src/modals/external-pdf-modals.ts#L249
async function createDocument(editor: Editor, settings: PluginSettings, paperlessUrl: PaperlessInsertionData) {
	// Create the parent folder
	const folderPath = normalizePath(settings.documentStoragePath);
	if (folderPath) {
		const folderRef = this.app.vault.getAbstractFileByPath(folderPath);
		const folderExists = !!(folderRef) && folderRef instanceof TFolder;
		if (!folderExists) {
			await this.app.vault.createFolder(folderPath);
		}
	}
	
	const filename = 'paperless-' + paperlessUrl.documentId + '.pdf';
	const fileRef = this.app.vault.getAbstractFileByPath(folderPath + '/' + filename); 
	const fileExists = !!(fileRef) && fileRef instanceof TFile;
	if (!fileExists) {
		const shareLink = await getShareLink(settings, paperlessUrl.documentId);
		if (shareLink) {
			await this.app.vault.create(folderPath + '/' + filename, shareLink.href);
		}
	}

	editor.replaceRange('![[' + filename + ']]', paperlessUrl.range.from, paperlessUrl.range.to);
}

async function insertDocumentLink(editor: Editor, settings: PluginSettings, documentId: string) {
	const url = new URL(settings.paperlessUrl + '/api/documents/' + documentId + '/');
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
	const cursor = editor.getCursor();
	editor.replaceRange('[' + title + '](' + detailUrl.href + ')', cursor, cursor);
}

async function searchPaperlessDocuments(settings: PluginSettings, searchQuery: string, tagIds: number[] = []): Promise<string[]> {
	let urlStr = settings.paperlessUrl + '/api/documents/?format=json';
	if (searchQuery) {
		urlStr += '&title_content=' + encodeURIComponent(searchQuery);
	}
	if (tagIds.length > 0) {
		urlStr += '&tags__id__all=' + tagIds.join(',');
	}
	console.log("Querying " + urlStr)
	const url = new URL(urlStr);
	try {
		const result = await requestUrl({
			url: url.toString(),
			headers: {
				'Authorization': 'token ' + settings.paperlessAuthToken
			}
		});
		if (result.status === 200 && result.json['all']) {
			return result.json['all'];
		}
		console.error('Search returned unexpected response:', result);
		return [];
	} catch (error) {
		console.error('Error searching Paperless:', error);
		throw error;
	}
}

class DocumentSelectorModal extends Modal {
	editor: Editor;
	settings: PluginSettings;
	mode: 'embed' | 'link';
	currentPage: number;
	batchSize: number;
	loadedAssets: Map<number, HTMLElement>;
	scrollContainer: HTMLElement | null;
	isLoading: boolean;
	scrollTimeout: number | null;
	searchTimeout: number | null;
	selectedTags: Set<number>;
	availableDocumentIds: string[];

	constructor(app: App, editor: Editor, settings: PluginSettings, mode: 'embed' | 'link' = 'embed') {
		super(app);
		this.editor = editor;
		this.settings = settings;
		this.mode = mode;
		this.currentPage = 0;
		this.batchSize = 6;
		this.loadedAssets = new Map();
		this.scrollContainer = null;
		this.isLoading = false;
		this.scrollTimeout = null;
		this.searchTimeout = null;
		this.selectedTags = new Set();
		this.availableDocumentIds = [];
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
	};

	async displayTags(tagDiv: HTMLDivElement, documentId: string) {
		const thumbUrl = this.settings.paperlessUrl + '/api/documents/' + documentId + '/';
		const result = await requestUrl({
			url: thumbUrl.toString(),
			headers: {
				'Authorization': 'token ' + this.settings.paperlessAuthToken
			}
		})
		const tags = result.json['tags']
		for (let x = 0; x < tags.length; x++) {
			const currentTag = tagDiv.createDiv();
			const tagData = tagCache.get(tags[x]);					
			const tagStr = currentTag.createEl('span', {text: tagData['name']});
			tagStr.setCssStyles({color: tagData['text_color'], fontSize: '0.7em'});
			currentTag.setCssStyles({background: tagData['color'], borderRadius: '8px', padding: '2px', marginTop: '1px', marginRight: '5px'})
		}
	};

	async onOpen() {
		const {contentEl} = this;

		if (cachedResult == null) {
			await refreshCacheFromPaperless(this.settings);
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
		const tags = Array.from(tagCache.entries()).sort((a, b) => a[1]['name'].localeCompare(b[1]['name']));
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

		// Toggle dropdown visibility
		tagFilterButton.onclick = (e) => {
			e.stopPropagation();
			tagDropdown.style.display = tagDropdown.style.display === 'none' ? 'block' : 'none';
		};

		// Close dropdown when clicking outside
		contentEl.addEventListener('click', () => {
			tagDropdown.style.display = 'none';
		});

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
				new Notice('Failed to refresh cache');
				console.error('Refresh failed:', error);
				refreshButton.disabled = false;
				refreshButton.setText('\u21bb Refresh');
			}
		};

		const totalWidth = contentEl.innerWidth;
		this.availableDocumentIds = cachedResult.json['all'].sort((a:String, b:String) => {return +a - +b}).reverse();
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
		loadingDiv.setText('Loading documents...');
		loadingDiv.style.display = 'none';

		searchInput.addEventListener('input', async (e) => {
			if (this.searchTimeout) {
				clearTimeout(this.searchTimeout);
			}

			// Debounce: wait 500ms after user stops typing
			this.searchTimeout = window.setTimeout(async () => {
				const searchQuery = (e.target as HTMLInputElement).value.trim();
				
			if (searchQuery === '' && this.selectedTags.size === 0) {
				// Reset to cached results
				this.availableDocumentIds = cachedResult.json['all'].sort((a:String, b:String) => {return +a - +b}).reverse();
			} else {
				// Perform search
				searchInput.disabled = true;
				loadingDiv.setText('Searching...');
				loadingDiv.style.display = 'block';
				
				try {
					const tagIds = Array.from(this.selectedTags);
					const searchResults = await searchPaperlessDocuments(this.settings, searchQuery, tagIds);
					this.availableDocumentIds = searchResults.sort((a:String, b:String) => {return +a - +b}).reverse();
				} catch (error) {
					new Notice('Failed to search documents');
					console.error('Search failed:', error);
					loadingDiv.style.display = 'none';
				} finally {
					searchInput.disabled = false;
					loadingDiv.style.display = 'none';
				}
			}				// Reset and reload modal content
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
			
			imgElement.onclick = () => {
				if (this.mode === 'link') {
					insertDocumentLink(this.editor, this.settings, documentId);
				} else {
					const cursor = this.editor.getCursor();
					const documentInfo: PaperlessInsertionData = {
						documentId: documentId,
						range: {
							from: { line: cursor.line, ch: cursor.ch },
							to: { line: cursor.line, ch: cursor.ch }
						}
					}
					createDocument(this.editor, this.settings, documentInfo);
				}
				overallDiv.setCssStyles({opacity: '0.5'});
			};
			
			imgElement.onerror = () => {
				overallDiv.setText('Failed to load');
			};
			
			this.displayThumbnail(imgElement, documentId);
			this.loadedAssets.set(i, overallDiv);
		}

		this.currentPage = endIndex;

		setTimeout(() => {
			this.isLoading = false;
			if (endIndex >= availableDocumentIds.length) {
				loadingDiv.style.display = 'none';
			}
		}, 100);
	}

	onClose() {
		if (this.scrollTimeout) {
			clearTimeout(this.scrollTimeout);
		}
		if (this.searchTimeout) {
			clearTimeout(this.searchTimeout);
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
