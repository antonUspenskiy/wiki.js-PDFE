const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb, PDFName, PDFArray } = require('pdf-lib');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const cleanup = require('./cleanup');

// Parse command line arguments
const argv = yargs(hideBin(process.argv))
    .option('config', {
        alias: 'c',
        type: 'string',
        description: 'Path to config file',
        default: './config.json'
    })
    .option('url', {
        alias: 'u',
        type: 'string',
        description: 'Full page URL (includes base and path)'
    })
    .option('email', {
        alias: 'e',
        type: 'string',
        description: 'Email for login'
    })
    .option('password', {
        alias: 'p',
        type: 'string',
        description: 'Password for login'
    })
    .option('article', {
        alias: 'a',
        type: 'string',
        description: 'Path to the article'
    })
    .option('output', {
        alias: 'o',
        type: 'string',
        description: 'Output directory'
    })
    .option('base', {
        alias: 'b',
        type: 'string',
        description: 'Base wiki URL'
    })
    .option('apikey', {
        alias: 'k',
        type: 'string',
        description: 'Wiki.js API key (Bearer token)'
    })
    .option('login-path', {
        type: 'string',
        description: 'Login path override'
    })
    .option('skip-login', {
        type: 'boolean',
        description: 'Skip login step and open article directly',
        default: false
    })
    .option('pdf-name', {
        type: 'string',
        description: 'Output PDF filename override'
    })
    .option('headless', {
        type: 'boolean',
        description: 'Run Chromium in headless mode',
        default: false
    })
    .option('timeout', {
        type: 'number',
        description: 'Navigation timeout in milliseconds'
    })
    .option('font-size', {
        type: 'number',
        description: 'Override base body font size (px) for PDF rendering'
    })
    .option('footnote-font-size', {
        type: 'number',
        description: 'Footnote font size in pt (default: 8)'
    })
    .help()
    .argv;

// Load and merge configuration
const defaultConfig = {
    baseUrl: '',
    loginPath: '/login',
    articlePath: '',
    credentials: {},
    outputDir: './exported',
    timeout: 30000,
    headless: false,
    skipLogin: false,
    fontSize: null,
    footnoteFontSize: 8
};

let fileConfig = {};
if (argv.config && fs.existsSync(argv.config)) {
    try {
        fileConfig = JSON.parse(fs.readFileSync(argv.config, 'utf8'));
    } catch (error) {
        console.error('Error loading config file:', error.message);
        process.exit(1);
    }
} else if (argv.config && argv.config !== './config.json') {
    console.error('Config file not found:', argv.config);
    process.exit(1);
}

let config = {
    ...defaultConfig,
    ...fileConfig,
    credentials: {
        ...(defaultConfig.credentials || {}),
        ...((fileConfig && fileConfig.credentials) || {})
    }
};

// Override config with command line arguments
if (argv.url) config.pageUrl = argv.url;
if (argv.base) config.baseUrl = argv.base;
if (argv.email) config.credentials.email = argv.email;
if (argv.password) config.credentials.password = argv.password;
if (argv.article) config.articlePath = argv.article;
if (argv.output) config.outputDir = argv.output;
if (argv.apikey) config.apiKey = argv.apikey;
if (typeof argv.loginPath === 'string') config.loginPath = argv.loginPath;
if (argv.skipLogin) config.skipLogin = true;
if (typeof argv.pdfName === 'string') config.pdfName = argv.pdfName;
if (typeof argv.headless === 'boolean') config.headless = argv.headless;
if (typeof argv.timeout === 'number' && Number.isFinite(argv.timeout) && argv.timeout > 0) {
    config.timeout = argv.timeout;
}
if (typeof argv.fontSize === 'number') config.fontSize = argv.fontSize;
if (typeof argv.footnoteFontSize === 'number') config.footnoteFontSize = argv.footnoteFontSize;

// Derive baseUrl/articlePath from pageUrl only when explicit base/article are not provided.
// This prevents export-all from being overwritten by a single-page URL stored in config.json.
const hasExplicitBaseOrArticle = Boolean(argv.base || argv.article);
const shouldDeriveFromPageUrl = Boolean(config && config.pageUrl && (argv.url || !hasExplicitBaseOrArticle));
if (shouldDeriveFromPageUrl) {
    try {
        const u = new URL(config.pageUrl);
        config.baseUrl = u.origin;
        // keep query string to support dynamic pages
        config.articlePath = u.pathname + (u.search || '');
        // Ensure a default loginPath if missing
        if (!config.loginPath) config.loginPath = '/login';
    } catch (e) {
        console.error('Invalid pageUrl in config:', config.pageUrl);
        process.exit(1);
    }
}

if (!config.baseUrl || !config.articlePath) {
    console.error('Missing required page target. Provide --url or both --base and --article.');
    process.exit(1);
}

if (!config.outputDir) {
    console.error('Missing output directory. Provide --output or set outputDir in config.');
    process.exit(1);
}

if (typeof config.baseUrl === 'string') {
    config.baseUrl = config.baseUrl.replace(/\/+$/, '');
}
if (typeof config.articlePath === 'string' && config.articlePath && !config.articlePath.startsWith('/')) {
    config.articlePath = `/${config.articlePath}`;
}

if (!config.loginPath) config.loginPath = '/login';
if (!config.credentials || typeof config.credentials !== 'object') config.credentials = {};
if (!Number.isFinite(config.timeout) || config.timeout <= 0) config.timeout = defaultConfig.timeout;
if (typeof config.headless !== 'boolean') config.headless = false;
if (typeof config.skipLogin !== 'boolean') config.skipLogin = false;
const parsedFontSize = Number(config.fontSize);
config.fontSize = Number.isFinite(parsedFontSize) && parsedFontSize > 0 ? parsedFontSize : null;
const parsedFootnoteFontSize = Number(config.footnoteFontSize);
config.footnoteFontSize = Number.isFinite(parsedFootnoteFontSize) && parsedFootnoteFontSize > 0
    ? parsedFootnoteFontSize
    : defaultConfig.footnoteFontSize;

// Вспомогательные функции
function getResourceType(url) {
    if (/\.(woff2?|ttf|eot)$/i.test(url)) return 'font';
    if (/\.(png|jpe?g|gif|svg|webp)$/i.test(url)) return 'image';
    if (/\.css$/i.test(url)) return 'style';
    return null;
}

function getSafeFilename(url) {
    return decodeURIComponent(path.basename(url.split('?')[0]))
        .replace(/[^\w.-]/g, '_');
}

async function saveAllResources(resourcesMap, outputDir) {
    for (const [url, resource] of resourcesMap) {
        try {
            const subDir = path.join(outputDir, resource.type + 's');
            if (!fs.existsSync(subDir)) fs.mkdirSync(subDir);
            fs.writeFileSync(path.join(subDir, resource.filename), resource.buffer);
        } catch (e) {
            console.log(`Ошибка сохранения ${url}:`, e.message);
        }
    }
}

function fixHtmlPaths(html, baseUrl, outputDir) {
    return html
        .replace(new RegExp(baseUrl, 'g'), '.')
        .replace(/(href|src)=["']([^"']+)["']/g, (match, attr, url) => {
            if (url.startsWith('data:')) return match;
            const type = getResourceType(url);
            if (!type) return match;
            const filename = getSafeFilename(url);
            return `${attr}="./${type}s/${filename}"`;
        });
}

async function saveAllStyles(page, outputDir) {
    const stylesDir = path.join(outputDir, 'styles');
    if (!fs.existsSync(stylesDir)) fs.mkdirSync(stylesDir);
    
    const styles = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('style, link[rel="stylesheet"]'))
            .map(el => el.outerHTML);
    });
    
    fs.writeFileSync(path.join(stylesDir, 'inline_styles.css'), styles.join('\n'));
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

let pdfjsLibPromise;
async function getPdfjsLib() {
    if (!pdfjsLibPromise) {
        pdfjsLibPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
    }
    return pdfjsLibPromise;
}

async function extractMarkerPagesFromPdf(pdfPath, markerPrefix, markerSuffix) {
    const pdfjsLib = await getPdfjsLib();
    const data = new Uint8Array(fs.readFileSync(pdfPath));
    const loadingTask = pdfjsLib.getDocument({ data, disableWorker: true });
    const pdf = await loadingTask.promise;
    const pageCount = pdf.numPages;
    const markerPages = new Map();
    const pattern = new RegExp(`${escapeRegExp(markerPrefix)}(\\d+)${escapeRegExp(markerSuffix)}`, 'g');

    for (let pageIndex = 1; pageIndex <= pageCount; pageIndex++) {
        const page = await pdf.getPage(pageIndex);
        const textContent = await page.getTextContent();
        const text = textContent.items.map(item => item.str).join('');
        const normalized = text.replace(/\s+/g, '');
        let match;
        pattern.lastIndex = 0;
        while ((match = pattern.exec(normalized)) !== null) {
            const index = Number(match[1]);
            if (!Number.isNaN(index) && !markerPages.has(index)) {
                markerPages.set(index, pageIndex);
            }
        }
    }

    return { markerPages, pageCount };
}

async function getPdfPageCount(pdfPath) {
    const pdfjsLib = await getPdfjsLib();
    const data = new Uint8Array(fs.readFileSync(pdfPath));
    const loadingTask = pdfjsLib.getDocument({ data, disableWorker: true });
    const pdf = await loadingTask.promise;
    let pageCount = pdf.numPages;
    if (pageCount <= 1) return pageCount;
    const lastPage = await pdf.getPage(pageCount);
    const textContent = await lastPage.getTextContent();
    const text = textContent.items.map(item => item.str).join('').trim();
    if (!text) {
        pageCount -= 1;
    }
    return pageCount;
}

async function mergePdfsWithPageNumbers(tocPdfPath, contentPdfPath, outputPath) {
    const tocBytes = fs.readFileSync(tocPdfPath);
    const contentBytes = fs.readFileSync(contentPdfPath);

    const tocDoc = await PDFDocument.load(tocBytes);
    const contentDoc = await PDFDocument.load(contentBytes);
    const merged = await PDFDocument.create();

    const tocPages = await merged.copyPages(tocDoc, tocDoc.getPageIndices());
    tocPages.forEach(page => merged.addPage(page));

    const contentPages = await merged.copyPages(contentDoc, contentDoc.getPageIndices());
    contentPages.forEach(page => merged.addPage(page));

    const totalPages = merged.getPageCount();
    const font = await merged.embedFont(StandardFonts.Helvetica);
    const fontSize = 10;
    const margin = 28.35; // 1cm in points
    const color = rgb(0.27, 0.27, 0.27);

    for (let i = 0; i < totalPages; i++) {
        const page = merged.getPage(i);
        const text = `${i + 1} / ${totalPages}`;
        const textWidth = font.widthOfTextAtSize(text, fontSize);
        const x = page.getWidth() - margin - textWidth;
        const y = margin - fontSize;
        page.drawText(text, { x, y, size: fontSize, font, color });
    }

    const outputBytes = await merged.save();
    fs.writeFileSync(outputPath, outputBytes);
}

const MM_TO_PT = 72 / 25.4;

function mmToPt(mmValue) {
    const numeric = Number(mmValue);
    if (!Number.isFinite(numeric)) return 0;
    return numeric * MM_TO_PT;
}

function ptToMm(ptValue) {
    const numeric = Number(ptValue);
    if (!Number.isFinite(numeric)) return 0;
    return numeric / MM_TO_PT;
}

function safeDecodeURIComponent(value) {
    try {
        return decodeURIComponent(value);
    } catch (_) {
        return value;
    }
}

function sanitizeFootnoteToken(value, fallback = 'footnote') {
    const source = String(value || '').trim().toLowerCase();
    const safe = source
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48);
    return safe || fallback;
}

function cloneFootnoteSegments(segments) {
    if (!Array.isArray(segments)) return [];
    const prepared = segments
        .map(segment => ({
            text: String((segment && segment.text) || ''),
            href: segment && typeof segment.href === 'string' ? segment.href : null
        }))
        .filter(segment => segment.text.length > 0);

    if (!prepared.length) return [];

    prepared[0].text = prepared[0].text.replace(/^[\s\r\n]+/, '');
    const lastIndex = prepared.length - 1;
    prepared[lastIndex].text = prepared[lastIndex].text.replace(/[\s\r\n]+$/, '');

    const normalized = [];
    prepared.forEach(segment => {
        if (!segment.text) return;
        const last = normalized[normalized.length - 1];
        if (last && last.href === segment.href) {
            last.text += segment.text;
            return;
        }
        normalized.push({
            text: segment.text,
            href: segment.href
        });
    });

    return normalized;
}

function buildFootnoteSegmentsKey(segments) {
    const normalized = cloneFootnoteSegments(segments);
    if (!normalized.length) return '__EMPTY__';
    return normalized
        .map(segment => {
            const href = typeof segment.href === 'string' ? segment.href.trim() : '';
            const text = String(segment.text || '').replace(/\s+/g, ' ').trim();
            return `${href}::${text}`;
        })
        .join('|');
}

function formatFootnoteNumberLabel(numbers) {
    const normalized = (Array.isArray(numbers) ? numbers : [])
        .filter(value => Number.isFinite(value) && value > 0)
        .map(value => String(Math.trunc(value)));
    return normalized.join(', ');
}

function getFootnoteDisplayLabel(item) {
    if (!item || typeof item !== 'object') return '';
    const rawLabel = String(item.numberLabel || item.number || '').trim();
    if (!rawLabel) return '';

    const explicitNumbers = Array.isArray(item.numbers)
        ? item.numbers.filter(value => Number.isFinite(value) && value > 0)
        : [];
    const isGroupedLabel = explicitNumbers.length > 1 || rawLabel.includes(',');
    return isGroupedLabel ? rawLabel : `${rawLabel}.`;
}

function buildFootnotePagePlan(footnoteRefs, markerPages, definitionsById) {
    const pages = new Map();
    const refUpdates = [];
    const unresolvedRefs = [];
    let destinationCounter = 0;

    footnoteRefs.forEach(ref => {
        if (!ref || !Number.isFinite(ref.refIndex)) return;
        const page = markerPages.get(ref.refIndex);
        if (!page) {
            unresolvedRefs.push(ref.refIndex);
            return;
        }

        let pageEntry = pages.get(page);
        if (!pageEntry) {
            pageEntry = {
                page,
                items: [],
                byTargetId: new Map(),
                byDefinitionKey: new Map(),
                nextNumber: 1
            };
            pages.set(page, pageEntry);
        }

        const assignedNumber = pageEntry.nextNumber;
        pageEntry.nextNumber += 1;

        const definitionSegments = definitionsById.get(ref.targetId);
        const hasDefinition = Array.isArray(definitionSegments) && definitionSegments.length > 0;
        const segments = hasDefinition
            ? cloneFootnoteSegments(definitionSegments)
            : [{ text: '(footnote text unavailable)', href: null }];

        const definitionGroupKey = hasDefinition
            ? `definition:${buildFootnoteSegmentsKey(segments)}`
            : null;

        const isContiguous = (item) => {
            if (!item || !Number.isFinite(item.lastAssignedNumber)) return false;
            return item.lastAssignedNumber === assignedNumber - 1;
        };

        let footnoteItem = pageEntry.byTargetId.get(ref.targetId);
        if (!isContiguous(footnoteItem)) {
            footnoteItem = null;
        }
        if (!footnoteItem && definitionGroupKey) {
            const byDefinition = pageEntry.byDefinitionKey.get(definitionGroupKey);
            if (isContiguous(byDefinition)) {
                footnoteItem = byDefinition;
            }
        }

        if (!footnoteItem) {
            const safeTarget = sanitizeFootnoteToken(ref.targetId, `fn-${assignedNumber}`);
            destinationCounter += 1;
            const destName = `export-footnote-${destinationCounter}-${safeTarget}`;

            footnoteItem = {
                targetId: ref.targetId,
                targetIds: [ref.targetId],
                number: 0,
                numberLabel: '',
                numbers: [],
                lastAssignedNumber: null,
                destName,
                segments
            };
            pageEntry.items.push(footnoteItem);
        } else {
            if (!Array.isArray(footnoteItem.targetIds)) {
                footnoteItem.targetIds = footnoteItem.targetId ? [footnoteItem.targetId] : [];
            }
            if (!footnoteItem.targetIds.includes(ref.targetId)) {
                footnoteItem.targetIds.push(ref.targetId);
            }
        }

        footnoteItem.numbers.push(assignedNumber);
        footnoteItem.number = footnoteItem.numbers[0];
        footnoteItem.numberLabel = formatFootnoteNumberLabel(footnoteItem.numbers);
        footnoteItem.lastAssignedNumber = assignedNumber;

        pageEntry.byTargetId.set(ref.targetId, footnoteItem);
        if (definitionGroupKey) {
            pageEntry.byDefinitionKey.set(definitionGroupKey, footnoteItem);
        }

        refUpdates.push({
            refIndex: ref.refIndex,
            newNumber: assignedNumber,
            newLabel: String(assignedNumber),
            destName: footnoteItem.destName
        });
    });

    const orderedPages = Array.from(pages.keys())
        .sort((a, b) => a - b)
        .map(page => {
            const entry = pages.get(page);
            return {
                page,
                items: entry.items.map(item => ({
                    targetId: item.targetId,
                    targetIds: Array.isArray(item.targetIds) ? [...item.targetIds] : [item.targetId],
                    number: item.number,
                    numberLabel: item.numberLabel || formatFootnoteNumberLabel(item.numbers),
                    numbers: Array.isArray(item.numbers) ? [...item.numbers] : [item.number],
                    destName: item.destName,
                    segments: cloneFootnoteSegments(item.segments)
                }))
            };
        });

    return { pages: orderedPages, refUpdates, unresolvedRefs };
}

function shiftFootnotePlansByOffset(pagePlans, pageOffset) {
    const offset = Number.isFinite(pageOffset) ? pageOffset : 0;
    return (Array.isArray(pagePlans) ? pagePlans : []).map(plan => ({
        finalPage: Number(plan.page) + offset,
        items: (plan.items || []).map(item => ({
            targetId: item.targetId,
            targetIds: Array.isArray(item.targetIds) ? [...item.targetIds] : [item.targetId],
            number: item.number,
            numberLabel: String(item.numberLabel || ''),
            numbers: Array.isArray(item.numbers) ? [...item.numbers] : [item.number],
            destName: item.destName,
            segments: cloneFootnoteSegments(item.segments)
        }))
    }));
}

function tokenizeFootnoteText(text) {
    const normalized = String(text || '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/\u00A0/g, ' ');

    const tokens = [];
    let buffer = '';
    const flush = () => {
        if (!buffer) return;
        tokens.push({ type: 'text', text: buffer });
        buffer = '';
    };

    for (const char of normalized) {
        if (char === '\n') {
            flush();
            tokens.push({ type: 'newline' });
            continue;
        }
        if (/\s/.test(char)) {
            flush();
            const last = tokens[tokens.length - 1];
            if (!last || last.type !== 'space') {
                tokens.push({ type: 'space', text: ' ' });
            }
            continue;
        }
        buffer += char;
    }
    flush();
    return tokens;
}

function splitWordByWidth(word, maxWidthPt, font, fontSizePt) {
    const glyphs = Array.from(String(word || ''));
    if (!glyphs.length) return [];

    const parts = [];
    let chunk = '';
    glyphs.forEach(glyph => {
        const candidate = chunk + glyph;
        const candidateWidth = font.widthOfTextAtSize(candidate, fontSizePt);
        if (chunk && candidateWidth > maxWidthPt) {
            parts.push(chunk);
            chunk = glyph;
            return;
        }
        chunk = candidate;
    });
    if (chunk) parts.push(chunk);
    return parts;
}

function layoutFootnoteSegments(segments, maxWidthPt, font, fontSizePt) {
    const lines = [];
    let currentLine = [];
    let currentWidth = 0;

    const trimTrailingSpaces = () => {
        while (currentLine.length && currentLine[currentLine.length - 1].isSpace) {
            const tail = currentLine.pop();
            currentWidth -= tail.width;
        }
    };

    const commitLine = (allowEmpty) => {
        trimTrailingSpaces();
        if (allowEmpty || currentLine.length > 0) {
            lines.push(currentLine);
        }
        currentLine = [];
        currentWidth = 0;
    };

    const appendFragment = (text, href, isSpace) => {
        if (!text) return;
        const width = font.widthOfTextAtSize(text, fontSizePt);
        if (width <= 0) return;
        const last = currentLine[currentLine.length - 1];
        if (last && last.href === (href || null) && last.isSpace === Boolean(isSpace)) {
            last.text += text;
            last.width += width;
            currentWidth += width;
            return;
        }
        currentLine.push({
            text,
            href: href || null,
            width,
            isSpace: Boolean(isSpace)
        });
        currentWidth += width;
    };

    (segments || []).forEach(segment => {
        const href = segment && typeof segment.href === 'string' ? segment.href : null;
        const tokens = tokenizeFootnoteText(segment && segment.text);

        tokens.forEach(token => {
            if (token.type === 'newline') {
                commitLine(true);
                return;
            }

            const text = token.text || '';
            const isSpace = token.type === 'space';
            if (!text) return;

            if (isSpace && currentWidth <= 0) {
                return;
            }

            const width = font.widthOfTextAtSize(text, fontSizePt);
            if (!isSpace && width > maxWidthPt) {
                const chunks = splitWordByWidth(text, maxWidthPt, font, fontSizePt);
                chunks.forEach((chunk, index) => {
                    const chunkWidth = font.widthOfTextAtSize(chunk, fontSizePt);
                    if (currentWidth > 0 && currentWidth + chunkWidth > maxWidthPt) {
                        commitLine(false);
                    }
                    appendFragment(chunk, href, false);
                    if (index < chunks.length - 1) {
                        commitLine(false);
                    }
                });
                return;
            }

            if (currentWidth > 0 && currentWidth + width > maxWidthPt) {
                commitLine(false);
                if (isSpace) return;
            }

            appendFragment(text, href, isSpace);
        });
    });

    trimTrailingSpaces();
    if (currentLine.length) {
        lines.push(currentLine);
    }
    if (!lines.length) {
        lines.push([]);
    }

    return lines;
}

function layoutFootnotesForPage(items, maxWidthPt, font, fontSizePt, lineHeightPt, itemGapPt) {
    const itemLayouts = (items || []).map(item => {
        const itemLabel = getFootnoteDisplayLabel(item);
        const segments = [
            { text: `${itemLabel} `, href: null },
            ...cloneFootnoteSegments(item.segments)
        ];
        const lines = layoutFootnoteSegments(segments, maxWidthPt, font, fontSizePt);
        return {
            item,
            lines,
            heightPt: lines.length * lineHeightPt
        };
    });

    let totalHeightPt = 0;
    itemLayouts.forEach((layout, index) => {
        totalHeightPt += layout.heightPt;
        if (index < itemLayouts.length - 1) {
            totalHeightPt += itemGapPt;
        }
    });

    return { itemLayouts, totalHeightPt };
}

async function estimateFootnoteAreaMm(pagePlans, options) {
    const plans = Array.isArray(pagePlans) ? pagePlans : [];
    if (!plans.length) {
        return { maxRequiredMm: 0, perPageMm: new Map() };
    }

    const measurementDoc = await PDFDocument.create();
    const measurementFont = await measurementDoc.embedFont(StandardFonts.Helvetica);
    const lineHeightPt = options.fontSizePt * options.lineHeightMultiplier;
    const itemGapPt = options.itemGapPt;
    const perPageMm = new Map();
    let maxRequiredPt = 0;

    plans.forEach(pagePlan => {
        const layout = layoutFootnotesForPage(
            pagePlan.items,
            options.availableWidthPt,
            measurementFont,
            options.fontSizePt,
            lineHeightPt,
            itemGapPt
        );
        const requiredPt = layout.totalHeightPt + options.topPaddingPt + options.bottomPaddingPt;
        perPageMm.set(pagePlan.page, ptToMm(requiredPt));
        if (requiredPt > maxRequiredPt) maxRequiredPt = requiredPt;
    });

    return { maxRequiredMm: ptToMm(maxRequiredPt), perPageMm };
}

function getPdfNameOrNull(name) {
    const raw = String(name || '').trim();
    if (!raw) return null;
    try {
        return PDFName.of(raw);
    } catch (_) {
        try {
            return PDFName.of(encodeURIComponent(raw));
        } catch (_) {
            return null;
        }
    }
}

function ensurePdfDestinationsDict(pdfDoc) {
    const catalogDict = pdfDoc.catalog.dict;
    const key = PDFName.of('Dests');
    const existing = catalogDict.get(key);
    if (existing) {
        const resolved = pdfDoc.context.lookup(existing);
        if (resolved) return resolved;
    }
    const created = pdfDoc.context.obj({});
    catalogDict.set(key, created);
    return created;
}

function collectExistingDestinationNames(pdfDoc) {
    const names = new Set();
    const catalogDict = pdfDoc.catalog.dict;
    const key = PDFName.of('Dests');
    const existing = catalogDict.get(key);
    if (!existing) return names;

    const dests = pdfDoc.context.lookup(existing);
    if (!dests || typeof dests.keys !== 'function') return names;

    for (const destKey of dests.keys()) {
        const raw = String(destKey || '').replace(/^\//, '');
        if (raw) names.add(raw);
    }
    return names;
}

function setPdfNamedDestination(pdfDoc, destsDict, destinationName, page, xPt, yPt) {
    const key = getPdfNameOrNull(destinationName);
    if (!key) return false;
    const destination = pdfDoc.context.obj([
        page.ref,
        PDFName.of('XYZ'),
        Number(xPt.toFixed(2)),
        Number(yPt.toFixed(2)),
        0
    ]);
    destsDict.set(key, destination);
    return true;
}

function ensurePdfPageAnnotationsArray(pdfDoc, page) {
    const annotsKey = PDFName.of('Annots');
    const existing = page.node.get(annotsKey);
    if (existing) {
        const resolved = pdfDoc.context.lookup(existing);
        if (resolved instanceof PDFArray) {
            return resolved;
        }
    }
    const created = pdfDoc.context.obj([]);
    page.node.set(annotsKey, created);
    return created;
}

function addPdfLinkAnnotation(pdfDoc, page, rect, linkSpec) {
    if (!linkSpec) return;
    const [x1, y1, x2, y2] = rect.map(v => Number.isFinite(v) ? Number(v.toFixed(2)) : 0);
    if (x2 <= x1 || y2 <= y1) return;

    const base = {
        Type: 'Annot',
        Subtype: 'Link',
        Rect: [x1, y1, x2, y2],
        Border: [0, 0, 0]
    };

    if (linkSpec.type === 'external') {
        base.A = pdfDoc.context.obj({
            Type: 'Action',
            S: 'URI',
            URI: linkSpec.href
        });
    } else if (linkSpec.type === 'internal') {
        const destName = getPdfNameOrNull(linkSpec.destName);
        if (!destName) return;
        base.Dest = destName;
    } else {
        return;
    }

    const annotationRef = pdfDoc.context.register(pdfDoc.context.obj(base));
    const annots = ensurePdfPageAnnotationsArray(pdfDoc, page);
    annots.push(annotationRef);
}

function resolveFootnoteLinkSpec(href, existingDestinationNames) {
    const raw = String(href || '').trim();
    if (!raw) return null;

    if (raw.startsWith('#')) {
        const rawHash = raw.slice(1);
        if (!rawHash) return null;
        const decoded = safeDecodeURIComponent(rawHash);
        const encodedDecoded = encodeURIComponent(decoded);
        const candidates = [rawHash, decoded, encodedDecoded]
            .map(value => String(value || '').trim())
            .filter(Boolean);
        const uniqueCandidates = Array.from(new Set(candidates));
        const preferred = uniqueCandidates.find(candidate => existingDestinationNames.has(candidate))
            || uniqueCandidates[0];
        return preferred ? { type: 'internal', destName: preferred } : null;
    }

    const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw);
    if (hasScheme || raw.startsWith('/')) {
        return { type: 'external', href: raw };
    }
    return null;
}

function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function escapeHtmlAttr(value) {
    return escapeHtml(value).replace(/\n/g, '&#10;');
}

function buildFootnoteOverlayHtml(totalPages, finalFootnotePlans, options) {
    const byPage = new Map();
    (Array.isArray(finalFootnotePlans) ? finalFootnotePlans : []).forEach(plan => {
        if (!plan || !Number.isFinite(plan.finalPage)) return;
        byPage.set(plan.finalPage, plan);
    });

    const internalAnchorIds = new Set();
    byPage.forEach(plan => {
        (plan.items || []).forEach(item => {
            (item.segments || []).forEach(segment => {
                const href = String((segment && segment.href) || '').trim();
                if (!href.startsWith('#')) return;
                const raw = href.slice(1);
                if (raw) internalAnchorIds.add(raw);
                const decoded = safeDecodeURIComponent(raw);
                if (decoded) internalAnchorIds.add(decoded);
            });
        });
    });

    const renderSegments = (segments) => {
        const normalizedSegments = cloneFootnoteSegments(segments);
        return normalizedSegments.map(segment => {
            const text = escapeHtml(String((segment && segment.text) || ''));
            const href = segment && typeof segment.href === 'string' ? segment.href.trim() : '';
            if (href) {
                return `<a href="${escapeHtmlAttr(href)}">${text}</a>`;
            }
            return `<span>${text}</span>`;
        }).join('');
    };

    const anchorBank = Array.from(internalAnchorIds)
        .filter(Boolean)
        .map(id => `<a id="${escapeHtmlAttr(id)}" name="${escapeHtmlAttr(id)}"></a>`)
        .join('');

    const pageHtml = [];
    for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
        const pagePlan = byPage.get(pageNumber);
        const items = pagePlan && Array.isArray(pagePlan.items) ? pagePlan.items : [];
        const footnotesHtml = items.length
            ? `
                <div class="footnote-box">
                    ${items.map(item => `
                        <div class="footnote-item">
                            <a id="${escapeHtmlAttr(item.destName)}" name="${escapeHtmlAttr(item.destName)}" class="footnote-anchor" data-dest-name="${escapeHtmlAttr(item.destName)}"></a>
                            <span class="footnote-number">${escapeHtml(getFootnoteDisplayLabel(item))}</span>
                            <span class="footnote-content">${renderSegments(item.segments)}</span>
                        </div>
                    `).join('')}
                </div>
            `
            : '';

        pageHtml.push(`
            <section class="overlay-page" data-page-number="${pageNumber}">
                ${pageNumber === 1 ? `<div class="overlay-anchor-bank">${anchorBank}</div>` : ''}
                ${footnotesHtml}
            </section>
        `);
    }

    return `
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    @page { size: A4; margin: 0; }
    html, body { margin: 0; padding: 0; background: transparent; }
    body { font-family: Arial, Helvetica, sans-serif; color: #2f2f2f; }
    .overlay-page {
      width: 210mm;
      height: 297mm;
      position: relative;
      overflow: hidden;
      page-break-after: always;
      break-after: page;
      background: transparent;
    }
    .overlay-page:last-child {
      page-break-after: auto;
      break-after: auto;
    }
    .overlay-anchor-bank {
      position: absolute;
      left: 0;
      top: 0;
      width: 0;
      height: 0;
      overflow: hidden;
      pointer-events: none;
      opacity: 0;
    }
    .footnote-box {
      position: absolute;
      left: ${options.leftMarginMm}mm;
      right: ${options.rightMarginMm}mm;
      bottom: ${options.pageNumberBandMm}mm;
      max-height: ${options.footnoteAreaMm}mm;
      overflow: hidden;
      border-top: 0.2mm solid #c7c7c7;
      padding-top: ${options.topPaddingMm}mm;
      padding-bottom: ${options.bottomPaddingMm}mm;
      font-size: ${options.fontSizePt}pt;
      line-height: ${options.lineHeightMultiplier};
      box-sizing: border-box;
      color: #2f2f2f;
      background: transparent;
    }
    .footnote-item {
      margin: 0 0 ${options.itemGapMm}mm 0;
      break-inside: avoid;
      page-break-inside: avoid;
    }
    .footnote-item:last-child {
      margin-bottom: 0;
    }
    .footnote-anchor {
      display: block;
      width: 0;
      height: 0;
      overflow: hidden;
      pointer-events: none;
      opacity: 0;
    }
    .footnote-number {
      display: inline;
      font-weight: 600;
      margin-right: 0.9mm;
    }
    .footnote-content {
      display: inline;
      white-space: pre-wrap;
      word-break: break-word;
      overflow-wrap: anywhere;
    }
    .footnote-content a {
      color: #0b63ce;
      text-decoration: underline;
    }
  </style>
</head>
<body>
  ${pageHtml.join('\n')}
</body>
</html>
    `;
}

async function estimateFootnoteAreaMmInBrowser(page, pagePlans, options) {
    const plans = Array.isArray(pagePlans) ? pagePlans : [];
    if (!plans.length) {
        return { maxRequiredMm: 0, perPageMm: new Map() };
    }

    const result = await page.evaluate((inputPlans, measureOptions) => {
        const pxToMm = 25.4 / 96;
        const root = document.createElement('div');
        root.id = 'export-footnote-measure-root';
        root.style.position = 'fixed';
        root.style.left = '-20000px';
        root.style.top = '0';
        root.style.width = `${210 - measureOptions.leftMarginMm - measureOptions.rightMarginMm}mm`;
        root.style.pointerEvents = 'none';
        root.style.opacity = '0';
        root.style.zIndex = '-1';
        document.body.appendChild(root);

        const renderSegment = (segment) => {
            const href = String((segment && segment.href) || '').trim();
            const text = String((segment && segment.text) || '');
            const node = href ? document.createElement('a') : document.createElement('span');
            if (href) node.setAttribute('href', href);
            node.textContent = text;
            return node;
        };

        const perPage = [];
        let maxPx = 0;

        inputPlans.forEach(plan => {
            const box = document.createElement('div');
            box.style.borderTop = '0.2mm solid #c7c7c7';
            box.style.paddingTop = `${measureOptions.topPaddingMm}mm`;
            box.style.paddingBottom = `${measureOptions.bottomPaddingMm}mm`;
            box.style.fontSize = `${measureOptions.fontSizePt}pt`;
            box.style.lineHeight = String(measureOptions.lineHeightMultiplier);
            box.style.whiteSpace = 'normal';
            box.style.wordBreak = 'break-word';
            box.style.overflowWrap = 'anywhere';
            box.style.boxSizing = 'border-box';

            const items = Array.isArray(plan.items) ? plan.items : [];
            items.forEach((item, index) => {
                const row = document.createElement('div');
                if (index < items.length - 1) {
                    row.style.marginBottom = `${measureOptions.itemGapMm}mm`;
                }

                const number = document.createElement('span');
                const itemLabel = String(item.displayLabel || '').trim();
                number.textContent = `${itemLabel} `;
                number.style.fontWeight = '600';
                row.appendChild(number);

                const content = document.createElement('span');
                content.style.whiteSpace = 'pre-wrap';
                content.style.wordBreak = 'break-word';
                content.style.overflowWrap = 'anywhere';
                const segments = Array.isArray(item.segments) ? item.segments : [];
                segments.forEach(segment => {
                    content.appendChild(renderSegment(segment));
                });
                row.appendChild(content);
                box.appendChild(row);
            });

            root.appendChild(box);
            const heightPx = box.getBoundingClientRect().height;
            maxPx = Math.max(maxPx, heightPx);
            perPage.push({
                page: plan.page,
                mm: heightPx * pxToMm
            });
        });

        root.remove();
        return {
            maxRequiredMm: maxPx * pxToMm,
            perPage
        };
    }, plans.map(plan => ({
        ...plan,
        items: Array.isArray(plan.items)
            ? plan.items.map(item => ({
                ...item,
                displayLabel: getFootnoteDisplayLabel(item)
            }))
            : []
    })), options);

    return {
        maxRequiredMm: Number(result.maxRequiredMm) || 0,
        perPageMm: new Map(
            (Array.isArray(result.perPage) ? result.perPage : [])
                .filter(entry => entry && Number.isFinite(entry.page))
                .map(entry => [entry.page, Number(entry.mm) || 0])
        )
    };
}

async function injectFootnotesOverlayIntoPdf(browser, pdfPath, finalFootnotePlans, options) {
    if (!Array.isArray(finalFootnotePlans) || finalFootnotePlans.length === 0) return;

    const basePdfBytes = fs.readFileSync(pdfPath);
    const basePdfDoc = await PDFDocument.load(basePdfBytes);
    const totalPages = basePdfDoc.getPageCount();
    if (totalPages <= 0) return;

    const overlayPdfPath = pdfPath.replace(/\.pdf$/i, '.footnotes.overlay.pdf');
    const overlayHtml = buildFootnoteOverlayHtml(totalPages, finalFootnotePlans, options);
    const overlayPage = await browser.newPage();
    let overlayDestinationCoordinates = [];
    try {
        await overlayPage.setViewport({ width: 1200, height: 900, deviceScaleFactor: 1 });
        await overlayPage.setContent(overlayHtml, { waitUntil: 'networkidle0' });
        await overlayPage.emulateMediaType('screen');
        overlayDestinationCoordinates = await overlayPage.evaluate(() => {
            const pxToPt = 72 / 96;
            const destinations = [];
            const anchors = Array.from(document.querySelectorAll('.footnote-anchor[data-dest-name]'));
            anchors.forEach(anchor => {
                const destName = String(anchor.getAttribute('data-dest-name') || '').trim();
                if (!destName) return;
                const pageNode = anchor.closest('.overlay-page');
                if (!pageNode) return;
                const pageNumber = Number(pageNode.getAttribute('data-page-number'));
                if (!Number.isFinite(pageNumber)) return;

                const pageRect = pageNode.getBoundingClientRect();
                const anchorRect = anchor.getBoundingClientRect();
                const xPt = (anchorRect.left - pageRect.left) * pxToPt;
                const yFromTopPt = (anchorRect.top - pageRect.top) * pxToPt;

                destinations.push({
                    destName,
                    pageNumber,
                    xPt,
                    yFromTopPt
                });
            });
            return destinations;
        });
        await overlayPage.pdf({
            path: overlayPdfPath,
            format: 'A4',
            printBackground: true,
            preferCSSPageSize: true,
            displayHeaderFooter: false,
            margin: { top: '0', right: '0', bottom: '0', left: '0' }
        });
    } finally {
        await overlayPage.close();
    }

    const overlayPdfBytes = fs.readFileSync(overlayPdfPath);
    const overlayPdfDoc = await PDFDocument.load(overlayPdfBytes);
    const overlayPageCount = overlayPdfDoc.getPageCount();
    const pagesToMerge = Math.min(totalPages, overlayPageCount);
    if (pagesToMerge <= 0) return;

    const overlayIndices = Array.from({ length: pagesToMerge }, (_, index) => index);
    const embeddedOverlayPages = await basePdfDoc.embedPdf(overlayPdfBytes, overlayIndices);
    const copiedOverlayPages = await basePdfDoc.copyPages(
        overlayPdfDoc,
        overlayIndices
    );
    const basePages = basePdfDoc.getPages();

    for (let pageIndex = 0; pageIndex < pagesToMerge; pageIndex += 1) {
        const basePage = basePages[pageIndex];
        const embeddedOverlayPage = embeddedOverlayPages[pageIndex];
        const copiedOverlayPage = copiedOverlayPages[pageIndex];
        if (!basePage || !embeddedOverlayPage || !copiedOverlayPage) continue;

        basePage.drawPage(embeddedOverlayPage);

        const overlayAnnotsRef = copiedOverlayPage.node.get(PDFName.of('Annots'));
        if (overlayAnnotsRef) {
            const overlayAnnots = basePdfDoc.context.lookup(overlayAnnotsRef);
            if (overlayAnnots instanceof PDFArray) {
                const baseAnnots = ensurePdfPageAnnotationsArray(basePdfDoc, basePage);
                for (let idx = 0; idx < overlayAnnots.size(); idx += 1) {
                    const annotRef = overlayAnnots.get(idx);
                    if (!annotRef) continue;
                    const annotDict = basePdfDoc.context.lookup(annotRef);
                    if (annotDict && typeof annotDict.set === 'function') {
                        annotDict.set(PDFName.of('P'), basePage.ref);
                    }
                    baseAnnots.push(annotRef);
                }
            }
        }
    }

    const baseDests = ensurePdfDestinationsDict(basePdfDoc);
    const seenDestinationNames = new Set();
    (Array.isArray(overlayDestinationCoordinates) ? overlayDestinationCoordinates : [])
        .forEach(dest => {
            if (!dest || typeof dest.destName !== 'string') return;
            if (!dest.destName.startsWith('export-footnote-')) return;
            if (seenDestinationNames.has(dest.destName)) return;

            const pageIndex = Number(dest.pageNumber) - 1;
            if (!Number.isFinite(pageIndex) || pageIndex < 0 || pageIndex >= basePages.length) return;
            const targetPage = basePages[pageIndex];
            if (!targetPage) return;

            const xPt = Number.isFinite(dest.xPt) ? dest.xPt : 0;
            const yFromTopPt = Number.isFinite(dest.yFromTopPt) ? dest.yFromTopPt : 0;
            const pageHeightPt = targetPage.getHeight();
            const yPt = Math.max(0, Math.min(pageHeightPt, pageHeightPt - yFromTopPt));

            setPdfNamedDestination(basePdfDoc, baseDests, dest.destName, targetPage, xPt, yPt);
            seenDestinationNames.add(dest.destName);
        });

    const outputBytes = await basePdfDoc.save();
    fs.writeFileSync(pdfPath, outputBytes);

    try {
        if (fs.existsSync(overlayPdfPath)) {
            fs.unlinkSync(overlayPdfPath);
        }
    } catch (_) {
        // ignore temporary overlay cleanup errors
    }
}

async function injectFootnotesIntoPdf(pdfPath, finalFootnotePlans, options) {
    if (!Array.isArray(finalFootnotePlans) || finalFootnotePlans.length === 0) return;

    const pdfBytes = fs.readFileSync(pdfPath);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const textColor = rgb(0.18, 0.18, 0.18);

    const leftMarginPt = mmToPt(options.leftMarginMm);
    const rightMarginPt = mmToPt(options.rightMarginMm);
    const bottomMarginPt = mmToPt(options.bottomMarginMm);
    const pageNumberBandPt = mmToPt(options.pageNumberBandMm);
    const fontSizePt = options.fontSizePt;
    const lineHeightPt = fontSizePt * options.lineHeightMultiplier;
    const itemGapPt = options.itemGapPt;
    const topPaddingPt = options.topPaddingPt;
    const bottomPaddingPt = options.bottomPaddingPt;

    const footnoteTopY = bottomMarginPt - topPaddingPt;
    const footnoteMinY = pageNumberBandPt + bottomPaddingPt;
    const destsDict = ensurePdfDestinationsDict(pdfDoc);
    const existingDestinationNames = collectExistingDestinationNames(pdfDoc);

    finalFootnotePlans.forEach(pagePlan => {
        const pageIndex = Number(pagePlan.finalPage) - 1;
        if (!Number.isFinite(pageIndex) || pageIndex < 0) return;
        const pages = pdfDoc.getPages();
        if (pageIndex >= pages.length) return;

        const page = pages[pageIndex];
        const pageWidth = page.getWidth();
        const availableWidthPt = Math.max(40, pageWidth - leftMarginPt - rightMarginPt);
        const layout = layoutFootnotesForPage(
            pagePlan.items,
            availableWidthPt,
            font,
            fontSizePt,
            lineHeightPt,
            itemGapPt
        );

        if (!layout.itemLayouts.length) return;

        page.drawLine({
            start: { x: leftMarginPt, y: bottomMarginPt - 0.8 },
            end: { x: pageWidth - rightMarginPt, y: bottomMarginPt - 0.8 },
            thickness: 0.45,
            color: rgb(0.78, 0.78, 0.78)
        });

        let cursorY = footnoteTopY - fontSizePt;
        layout.itemLayouts.forEach((itemLayout, itemIndex) => {
            if (!itemLayout.lines.length) return;

            const destinationY = cursorY + lineHeightPt;
            setPdfNamedDestination(pdfDoc, destsDict, itemLayout.item.destName, page, leftMarginPt, destinationY);
            existingDestinationNames.add(itemLayout.item.destName);

            itemLayout.lines.forEach(line => {
                if (cursorY < footnoteMinY) return;
                let cursorX = leftMarginPt;
                line.forEach(fragment => {
                    if (!fragment.text) return;
                    page.drawText(fragment.text, {
                        x: cursorX,
                        y: cursorY,
                        size: fontSizePt,
                        font,
                        color: textColor
                    });

                    if (fragment.href && /\S/.test(fragment.text)) {
                        const linkSpec = resolveFootnoteLinkSpec(fragment.href, existingDestinationNames);
                        if (linkSpec) {
                            addPdfLinkAnnotation(pdfDoc, page, [
                                cursorX,
                                cursorY - 1.2,
                                cursorX + fragment.width,
                                cursorY + lineHeightPt - 1
                            ], linkSpec);
                        }
                    }
                    cursorX += fragment.width;
                });
                cursorY -= lineHeightPt;
            });

            if (itemIndex < layout.itemLayouts.length - 1) {
                cursorY -= itemGapPt;
            }
        });
    });

    const outputBytes = await pdfDoc.save();
    fs.writeFileSync(pdfPath, outputBytes);
}

// Основной класс для экспорта
class WikiExporter {
    constructor(config) {
        this.config = config;
        this.resources = new Map();
    }

    async init() {
        // Use Electron's Chromium with Linux-compatible paths
        let executablePath;
        if (process.platform === 'win32') {
            executablePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
        } else if (process.platform === 'darwin') {
            executablePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
        } else {
            // Linux - try common Chrome/Chromium paths
            const fs = require('fs');
            const possiblePaths = [
                '/usr/bin/google-chrome',
                '/usr/bin/google-chrome-stable',
                '/usr/bin/chromium-browser',
                '/usr/bin/chromium',
                '/snap/bin/chromium',
                '/opt/google/chrome/chrome',
                '/usr/local/bin/chrome'
            ];
            
            executablePath = possiblePaths.find(path => fs.existsSync(path));
            if (!executablePath) {
                console.error('Chrome/Chromium not found. Please install Chrome or Chromium browser.');
                console.error('Tried paths:', possiblePaths);
                process.exit(1);
            }
        }

        this.browser = await puppeteer.launch({
            headless: this.config.headless !== false,
            executablePath,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        this.page = await this.browser.newPage();
        if (this.config.apiKey) {
            await this.page.setExtraHTTPHeaders({
                Authorization: `Bearer ${this.config.apiKey}`
            });
        }
        // Use a wide desktop viewport so responsive layouts (tables/images) match ~1600px width,
        // while keeping the final PDF format unchanged.
        await this.page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });
        await this.setupRequestInterception();
    }

    async setupRequestInterception() {
        await this.page.setRequestInterception(true);
        this.page.on('request', request => request.continue());
        this.page.on('response', this.handleResponse.bind(this));
    }

    async handleResponse(response) {
        const url = response.url();
        const type = getResourceType(url);
        if (type) {
            try {
                const buffer = await response.buffer().catch(() => null);
                if (buffer) {
                    this.resources.set(url, {
                        buffer,
                        type,
                        filename: getSafeFilename(url)
                    });
                }
            } catch (e) {
                console.log(`Error loading ${url}:`, e.message);
            }
        }
    }

    async export() {
        try {
            // Create output directory structure
            this.createDirectoryStructure();

            // Login and navigate to article
            await this.loginToWiki();
            await this.navigateToArticle();

            // Save all resources
            await this.saveAllResources();
            await this.saveStyles();
            await this.saveHtml();
            const pdfPath = await this.savePdf();

            console.log('Page has been successfully exported to:', this.config.outputDir);
            console.log('PDF file has been saved as:', pdfPath);

            // Clean up temporary files (keep only PDF)
            await this.cleanupTempFiles(pdfPath);

            // Run cleanup after successful export
            console.log('\nRunning cleanup...');
            cleanup();

        } catch (error) {
            console.error('Export error:', error);
            throw error;
        } finally {
            await this.cleanup();
        }
    }

    createDirectoryStructure() {
        if (!fs.existsSync(this.config.outputDir)) {
            fs.mkdirSync(this.config.outputDir);
            ['fonts', 'images', 'styles'].forEach(folder => {
                fs.mkdirSync(path.join(this.config.outputDir, folder));
            });
        }
    }

    async loginToWiki() {
        if (this.config.skipLogin) {
            console.log('Skipping login step.');
            return;
        }

        await this.page.goto(`${this.config.baseUrl}${this.config.loginPath}`, {
            waitUntil: 'networkidle2',
            timeout: this.config.timeout
        });

        const findFirstSelector = async (selectors) => {
            for (const selector of selectors) {
                try {
                    const el = await this.page.$(selector);
                    if (el) return selector;
                } catch (_) { /* ignore invalid selectors */ }
            }
            return null;
        };

        const emailSelector = await findFirstSelector([
            'input[type="email"]',
            'input[autocomplete="email"]',
            'input[name="email"]',
            'input[name="username"]',
            'input[autocomplete="username"]',
            'input[type="text"][autocomplete="username"]',
            'input[placeholder*="email" i]',
            'input[placeholder*="e-mail" i]',
            'input[placeholder*="login" i]'
        ]);

        const passwordSelector = await findFirstSelector([
            'input[type="password"]',
            'input[autocomplete="current-password"]',
            'input[autocomplete="password"]',
            'input[name="password"]'
        ]);

        // If the login form isn't present (SSO already authenticated, or session cookie),
        // skip login instead of failing.
        if (!emailSelector && !passwordSelector) {
            return;
        }

        if (emailSelector && this.config.credentials.email) {
            await this.page.type(emailSelector, this.config.credentials.email);
        }
        if (passwordSelector && this.config.credentials.password) {
            await this.page.type(passwordSelector, this.config.credentials.password);
        }

        const buttonSelectors = [
            'button[type="submit"]',
            'button.v-btn--contained',
            'button[name="login"]',
            'form button'
        ];

        for (const selector of buttonSelectors) {
            try {
                const button = await this.page.$(selector);
                if (button) {
                    const nav = this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: this.config.timeout }).catch(() => null);
                    await button.click();
                    await nav;
                    return;
                }
            } catch (e) { continue; }
        }

        // If no button was found, try submitting the form with Enter.
        if (passwordSelector) {
            const nav = this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: this.config.timeout }).catch(() => null);
            await this.page.keyboard.press('Enter');
            await nav;
            return;
        }

        throw new Error('Could not find login button');
    }

    async navigateToArticle() {
        await this.page.goto(`${this.config.baseUrl}${this.config.articlePath}`, {
            waitUntil: 'networkidle2',
            timeout: this.config.timeout
        });
    }

    async saveAllResources() {
        await saveAllResources(this.resources, this.config.outputDir);
    }

    async saveStyles() {
        await saveAllStyles(this.page, this.config.outputDir);
    }

    async saveHtml() {
        const html = await this.page.content();
        const modifiedHtml = fixHtmlPaths(html, this.config.baseUrl, this.config.outputDir);
        fs.writeFileSync(path.join(this.config.outputDir, 'index.html'), modifiedHtml);
    }

    async savePdf() {
        const disableAllHtmlMutations = false;
        const pageTitle = await this.page.evaluate(() => {
            // First try to find the first visible H1 header
            const h1Elements = document.querySelectorAll('h1');
            for (const h1 of h1Elements) {
                const style = window.getComputedStyle(h1);
                if (style && style.display !== 'none' && style.visibility !== 'hidden') {
                    const text = h1.textContent.trim();
                    if (text) {
                        return text;
                    }
                }
            }

            // Fallback to other heading levels if no H1 found
            const headingSelectors = ['h2', 'h3', 'h4', 'h5', 'h6'];
            for (const selector of headingSelectors) {
                const elements = document.querySelectorAll(selector);
                for (const element of elements) {
                    const style = window.getComputedStyle(element);
                    if (style && style.display !== 'none' && style.visibility !== 'hidden') {
                        const text = element.textContent.trim();
                        if (text) {
                            return text;
                        }
                    }
                }
            }

            // Final fallback to document title
            return document.title || 'Wiki Page';
        });

        const cleanTitle = pageTitle
            .replace(/[\u00B6]/g, '')
            .replace(/[<>:"/\\|?*]/g, '_')
            .replace(/\s+/g, '_')
            .substring(0, 100);

        const baseName = cleanTitle || 'page';

        let pdfFilename = `${baseName}.pdf`;
        if (typeof this.config.pdfName === 'string' && this.config.pdfName.trim()) {
            pdfFilename = this.config.pdfName.trim();
            if (!/\.pdf$/i.test(pdfFilename)) {
                pdfFilename += '.pdf';
            }
            pdfFilename = pdfFilename
                .replace(/[\u00B6]/g, '')
                .replace(/[<>:"/\\|?*]/g, '_')
                .replace(/\s+/g, '_')
                .substring(0, 160);
        }
        let pdfPath = path.join(this.config.outputDir, pdfFilename);

        const logoPath = path.join(__dirname, 'assets', 'slomo-logo-traced-color.svg');
        let logoDataUri = '';
        try {
            if (fs.existsSync(logoPath)) {
                const svg = fs.readFileSync(logoPath, 'utf8');
                logoDataUri = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
            } else {
                console.warn('Logo not found:', logoPath);
            }
        } catch (e) {
            console.warn('Failed to read logo file:', e.message);
        }

        const hasCustomBaseFontSize = Number.isFinite(this.config.fontSize) && this.config.fontSize > 0;
        const footnoteFontSizePt = this.config.footnoteFontSize;
        const footnoteLineHeightMultiplier = 1.25;
        const footnoteMinAreaMm = 25;
        const pageNumberBandMm = 6;
        const footnoteItemGapPt = 2;
        const footnoteTopPaddingPt = 2;
        const footnoteBottomPaddingPt = 1;
        const pageWidthMm = 210;
        const horizontalMarginMm = 10;
        const printableContentWidthMm = pageWidthMm - (horizontalMarginMm * 2);

        let footnoteAreaMm = footnoteMinAreaMm;
        let bottomMarginMm = footnoteAreaMm + pageNumberBandMm;

        const pdfOptions = {
            format: 'A4',
            printBackground: true,
            margin: { top: '2cm', right: '1cm', bottom: `${bottomMarginMm}mm`, left: '1cm' },
            scale: 1,
            preferCSSPageSize: true
        };

        let pdfOptionsNoHeader = { ...pdfOptions, displayHeaderFooter: false };
        const headerTemplate = logoDataUri
            ? `
                <div style="width:100%; padding:0 1cm; box-sizing:border-box; height:34px; display:flex; justify-content:flex-end; align-items:flex-start;">
                    <img src="${logoDataUri}" style="height:27px; width:auto;" />
                </div>
            `
            : '<span></span>';
        const footerTemplate = `
            <div style="font-size:10px; width:100%; padding:0 1cm; box-sizing:border-box; color:#444;">
                <div style="width:100%; text-align:right;">
                    <span class="pageNumber"></span> / <span class="totalPages"></span>
                </div>
            </div>
        `;
        let pdfOptionsFinal = {
            ...pdfOptions,
            displayHeaderFooter: true,
            headerTemplate,
            footerTemplate
        };

        const applyPdfMarginState = () => {
            bottomMarginMm = footnoteAreaMm + pageNumberBandMm;
            const bottomMarginCss = `${bottomMarginMm}mm`;
            pdfOptions.margin = {
                top: '2cm',
                right: '1cm',
                bottom: bottomMarginCss,
                left: '1cm'
            };
            pdfOptionsNoHeader = { ...pdfOptions, displayHeaderFooter: false };
            pdfOptionsFinal = {
                ...pdfOptions,
                displayHeaderFooter: true,
                headerTemplate,
                footerTemplate
            };
            return { bottomMarginMm, bottomMarginCss };
        };
        const marginState = applyPdfMarginState();

        if (disableAllHtmlMutations) {
            await this.page.pdf({ path: pdfPath, ...pdfOptionsFinal });
            console.log('PDF file has been saved as:', pdfPath);
            return pdfPath;
        }

        // Ensure all images (including lazy and below-the-fold) are loaded and visible before generating PDF,
        // but do NOT modify the page layout or hide headers/navigation so that original styles are preserved.
        const disableImagePreprocess = false;
        const disableBgImageInjection = false;
        const disableTableMediaNormalization = false;
        if (!disableImagePreprocess) await this.page.evaluate(async (skipBgImageInjection, skipTableMediaNormalization) => {
            // 1) Auto-scroll the page to trigger lazy loading for images below the fold
            async function autoScroll() {
                await new Promise(resolve => {
                    let totalHeight = 0;
                    const distance = 500;
                    const timer = setInterval(() => {
                        const scrollHeight = document.body.scrollHeight;
                        window.scrollBy(0, distance);
                        totalHeight += distance;
                        if (totalHeight >= scrollHeight - window.innerHeight) {
                            clearInterval(timer);
                            // Small delay so late resources can start loading
                            setTimeout(resolve, 500);
                        }
                    }, 200);
                });
                // Return to top for better first-page layout
                window.scrollTo(0, 0);
            }

            await autoScroll();

            const imgs = Array.from(document.querySelectorAll('img'));

            // Force lazy-loaded images to load
            imgs.forEach(img => {
                const lazySrc =
                    img.getAttribute('data-src') ||
                    img.getAttribute('data-lazy-src') ||
                    img.getAttribute('data-original') ||
                    img.getAttribute('data-url');

                if (lazySrc && (!img.src || img.src === '' || img.src === window.location.href)) {
                    img.src = lazySrc;
                }

                // Disable lazy-loading hints so browser loads them now
                if (img.loading) img.loading = 'eager';
                if (img.decoding) img.decoding = 'sync';

                // Make sure images are visible in print
                img.style.visibility = 'visible';
                img.style.opacity = '1';
                // Only override display if it was explicitly hidden to avoid breaking inline images
                if (window.getComputedStyle(img).display === 'none') {
                    img.style.display = 'inline-block';
                }
            });

            // Also try to expose common background images as <img> tags so they show up in PDF
            if (!skipBgImageInjection) {
                const bgElements = Array.from(document.querySelectorAll('*')).filter(el => {
                    const style = window.getComputedStyle(el);
                    return style.backgroundImage && style.backgroundImage !== 'none';
                });

                bgElements.forEach(el => {
                    const style = window.getComputedStyle(el);
                    const match = style.backgroundImage.match(/url\\((['\"]?)(.*?)\\1\\)/i);
                    if (!match || !match[2]) return;
                    const url = match[2];
                    if (url.startsWith('data:')) return;

                    const img = document.createElement('img');
                    img.src = url;
                    img.style.maxWidth = '100%';
                    img.style.display = 'block';
                    img.style.margin = '8px 0';
                    // Mark so we don't duplicate processing
                    img.setAttribute('data-from-background', '1');
                    // Insert after original element so layout is close
                    el.insertAdjacentElement('afterend', img);
                    imgs.push(img);
                });
            }

            // Wait for all images to either load or error, but don't block forever
            await new Promise(resolve => {
                let pending = 0;
                function done() {
                    if (pending === 0) resolve();
                }

                imgs.forEach(img => {
                    if (img.complete && img.naturalWidth !== 0) {
                        return;
                    }
                    pending++;
                    const onFinish = () => {
                        pending--;
                        img.removeEventListener('load', onFinish);
                        img.removeEventListener('error', onFinish);
                        done();
                    };
                    img.addEventListener('load', onFinish);
                    img.addEventListener('error', onFinish);
                });

                // Safety timeout in case some images never fire events
                setTimeout(resolve, 5000);
                done();
            });

            // Preserve native table media sizing, but keep images shrinkable within a cell.
            if (!skipTableMediaNormalization) {
                const mediaTables = new Set();
                imgs.forEach(img => {
                    const table = img.closest('table');
                    if (!table) return;
                    mediaTables.add(table);

                    img.style.setProperty('max-width', '100%', 'important');
                    img.style.setProperty('height', 'auto', 'important');
                    img.style.setProperty('object-fit', 'contain', 'important');
                    img.style.setProperty('vertical-align', 'middle', 'important');

                    const cell = img.closest('td, th');
                    if (cell) {
                        const clone = cell.cloneNode(true);
                        clone.querySelectorAll('img, figure, svg, .image, .media, .v-image').forEach(node => node.remove());
                        const residualText = (clone.textContent || '').replace(/\s+/g, ' ').trim();
                        if (!residualText) {
                            img.style.setProperty('display', 'block', 'important');
                            img.style.setProperty('margin-left', 'auto', 'important');
                            img.style.setProperty('margin-right', 'auto', 'important');
                        }
                    }
                });

                mediaTables.forEach(table => {
                    table.setAttribute('data-export-media-table', '1');
                    table.style.setProperty('max-width', '100%', 'important');
                });
            }

            // Ensure images are not hidden by print styles
            const style = document.createElement('style');
            style.textContent = `
                @media print {
                    img, figure, svg, .image, .media, .v-image {
                        visibility: visible !important;
                        opacity: 1 !important;
                        max-width: 100% !important;
                        page-break-inside: avoid !important;
                        break-inside: avoid !important;
                    }
                }
            `;
            document.head.appendChild(style);
        }, disableBgImageInjection, disableTableMediaNormalization);

        // Convert all images to base64 data URIs to ensure they're embedded in the PDF
        const disableImageBase64 = false;
        await this.page.evaluate(async (skipImageBase64) => {
            if (skipImageBase64) return;
            const convertImageToBase64 = async (img) => {
                // Skip if already a data URI
                if (img.src && img.src.startsWith('data:')) {
                    return;
                }
                
                // Wait for image to load if not already loaded
                if (!img.complete || img.naturalWidth === 0) {
                    await new Promise((resolve, reject) => {
                        const timeout = setTimeout(() => reject(new Error('Image load timeout')), 10000);
                        img.onload = () => {
                            clearTimeout(timeout);
                            resolve();
                        };
                        img.onerror = () => {
                            clearTimeout(timeout);
                            reject(new Error('Image load error'));
                        };
                        // If already complete, resolve immediately
                        if (img.complete && img.naturalWidth > 0) {
                            clearTimeout(timeout);
                            resolve();
                        }
                    });
                }
                
                try {
                    // Use canvas to convert image to base64 (avoids CORS issues)
                    const canvas = document.createElement('canvas');
                    canvas.width = img.naturalWidth || img.width;
                    canvas.height = img.naturalHeight || img.height;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0);
                    img.src = canvas.toDataURL('image/png');
                } catch (error) {
                    // Fallback to fetch if canvas fails
                    try {
                        const response = await fetch(img.src, { credentials: 'include' });
                        if (!response.ok) throw new Error('Fetch failed');
                        
                        const blob = await response.blob();
                        const reader = new FileReader();
                        
                        await new Promise((resolve, reject) => {
                            reader.onloadend = () => {
                                img.src = reader.result;
                                resolve();
                            };
                            reader.onerror = reject;
                            reader.readAsDataURL(blob);
                        });
                    } catch (fetchError) {
                        console.warn('Failed to convert image to base64:', img.src, error);
                    }
                }
            };
            
            const images = Array.from(document.querySelectorAll('img'));
            await Promise.all(images.map(img => convertImageToBase64(img).catch(err => {
                console.warn('Image conversion failed:', img.src, err);
            })));
            
            // Also handle background images
            const elementsWithBgImages = Array.from(document.querySelectorAll('*')).filter(el => {
                const style = window.getComputedStyle(el);
                return style.backgroundImage && style.backgroundImage !== 'none' && !style.backgroundImage.startsWith('data:');
            });
            
            for (const el of elementsWithBgImages) {
                const style = window.getComputedStyle(el);
                const match = style.backgroundImage.match(/url\((['"]?)(.*?)\1\)/i);
                if (!match || !match[2]) continue;
                
                const url = match[2];
                if (url.startsWith('data:')) continue;
                
                try {
                    const response = await fetch(url, { credentials: 'include' });
                    if (!response.ok) continue;
                    
                    const blob = await response.blob();
                    const reader = new FileReader();
                    
                    await new Promise((resolve, reject) => {
                        reader.onloadend = () => {
                            el.style.backgroundImage = `url(${reader.result})`;
                            resolve();
                        };
                        reader.onerror = reject;
                        reader.readAsDataURL(blob);
                    });
                } catch (error) {
                    console.warn('Failed to convert background image to base64:', url, error);
                }
            }
        });

        // Wait a bit more to ensure all images are processed
        await new Promise(resolve => setTimeout(resolve, 1000));

        const disableNavHide = false;
        const disableNavHideAggressive = false;
        // Hide top/side navigation and other chrome, keep article styling
		if (!disableNavHide) await this.page.evaluate((skipAggressiveHide) => {
            const mainContentSelectors = [
                'main',
                '.main-content',
                '.content',
                '.article-content',
                '.page-content',
                '.wiki-content',
                '.post-content',
                '[role="main"]',
                '.container .row .col',
                '.page-body',
                '.article-body'
            ];
            
            let mainContentElement = null;
            for (const selector of mainContentSelectors) {
                const element = document.querySelector(selector);
                if (element) {
                    mainContentElement = element;
                    break;
                }
            }
            
            if (mainContentElement) {
                if (!skipAggressiveHide) {
                    let currentElement = mainContentElement.previousElementSibling;
                    while (currentElement) {
                        currentElement.style.display = 'none';
                        currentElement = currentElement.previousElementSibling;
                    }
                    
                    let parent = mainContentElement.parentElement;
                    while (parent && parent !== document.body) {
                        const siblings = Array.from(parent.children);
                        const mainIndex = siblings.indexOf(mainContentElement);
                        
                        for (let i = 0; i < mainIndex; i++) {
                            siblings[i].style.display = 'none';
                        }
                        
                        parent = parent.parentElement;
                    }
                }

                // Hide navigational/header chrome inside main content, but keep structural page headers/lines
                const headerBlocks = mainContentElement.querySelectorAll(
					'header, .content-header, .v-breadcrumbs, .breadcrumbs, .breadcrumb, nav, .navbar, .top-bar, .navigation'
				);
				headerBlocks.forEach(el => { el.style.display = 'none'; });

                if (!skipAggressiveHide) {
                    const candidateHeadings = Array.from(mainContentElement.querySelectorAll('h1, h2'));
                    let firstVisibleHeading = null;
                    for (const h of candidateHeadings) {
                        const style = window.getComputedStyle(h);
                        if (style && style.display !== 'none' && style.visibility !== 'hidden') {
                            firstVisibleHeading = h;
                            break;
                        }
                    }
                    if (firstVisibleHeading) {
                        let container = firstVisibleHeading.parentElement;
                        while (container && container !== mainContentElement) {
                            const children = Array.from(container.children);
                            const idx = children.indexOf(firstVisibleHeading);
                            for (let i = 0; i < idx; i++) {
                                children[i].style.display = 'none';
                            }
                            firstVisibleHeading = container;
                            container = container.parentElement;
                        }
                        if (firstVisibleHeading && firstVisibleHeading.parentElement === mainContentElement) {
                            const mainChildren = Array.from(mainContentElement.children);
                            const hIdx = mainChildren.indexOf(firstVisibleHeading);
                            for (let i = 0; i < hIdx; i++) {
                                mainChildren[i].style.display = 'none';
                            }
                        }
                    }
                }
            } else {
                const topElementsToHide = [
                    'header',
                    '.header',
                    '.navbar',
                    '.navigation',
                    '.nav-bar',
                    '.top-bar',
                    '.wiki-header',
                    '.page-header',
                    '.site-header',
                    '.main-header',
                    '.breadcrumb',
                    '.breadcrumbs',
                    '.v-breadcrumbs',
                    '.navbar-nav',
                    '.navbar-brand',
                    '.navbar-toggler',
                    '.navbar-collapse'
                ];
                
                topElementsToHide.forEach(selector => {
                    const elements = document.querySelectorAll(selector);
                    elements.forEach(el => {
                        const isInMainContent = el.closest('main, .main-content, .content, .article-content, .page-content');
                        if (!isInMainContent) {
                            el.style.display = 'none';
                        }
                    });
                });
            }

            // Remove footer / branding blocks such as "Powered by Wiki.js"
            const footerCandidates = document.querySelectorAll('footer, .footer, .app-footer, .v-footer, .site-footer, .page-footer, .wiki-footer');
            footerCandidates.forEach(el => {
                const text = (el.textContent || '').toLowerCase();
                if (text.includes('powered by wiki.js') || text.includes('wiki.js')) {
                    el.style.display = 'none';
                }
            });
            const poweredLinks = Array.from(document.querySelectorAll('a[href*="wiki.js"], a[href*="wiki-js"], a[href*="requarks"]'));
            poweredLinks.forEach(a => {
                const text = (a.textContent || '').toLowerCase();
                if (text.includes('powered')) {
                    const container = a.closest('footer, .footer, .app-footer, .v-footer, .site-footer, .page-footer, .wiki-footer') || a;
                    container.style.display = 'none';
                }
            });
        }, disableNavHideAggressive);

        const disableTableCellAlignment = false;
        // Preserve the original per-cell horizontal/vertical alignment so print styles
        // do not collapse everything to centered text.
        if (!disableTableCellAlignment) await this.page.evaluate(() => {
            const cells = document.querySelectorAll('table td, table th');
            cells.forEach(cell => {
                const cs = window.getComputedStyle(cell);
                if (cs.textAlign) cell.style.textAlign = cs.textAlign;
                if (cs.verticalAlign) cell.style.verticalAlign = cs.verticalAlign;
            });
        });

        const disablePrintStyleInjection = false;
        // Apply print/screen overrides to preserve on-page styling (colors, italics) and avoid cropped tables/images
        if (!disablePrintStyleInjection) await this.page.evaluate((baseFontSizePx, printContentWidthMm) => {
            if (document.querySelector('style[data-export-pdf]')) return;
            const rootFontSizeRule = Number.isFinite(baseFontSizePx) && baseFontSizePx > 0
                ? `font-size: ${baseFontSizePx}px !important;`
                : '';
            const bodyFontSizeRule = Number.isFinite(baseFontSizePx) && baseFontSizePx > 0
                ? `font-size: ${baseFontSizePx}px !important;`
                : '';
            const style = document.createElement('style');
            style.setAttribute('data-export-pdf', 'true');
            style.textContent = `
                @page {
                    size: A4;
                    margin: 2cm 1cm 1cm 1cm;
                }
                @media print, screen {
                    html, body {
                        margin: 0 !important;
                        padding: 0 !important;
                        width: 100% !important;
                        max-width: 100% !important;
                        transform: none !important;
                        zoom: 1 !important;
                        ${rootFontSizeRule}
                    }
                    /* Ensure the main content column expands to full page width once sidebars/nav are hidden */
                    main,
                    .main-content,
                    .content,
                    .article-content,
                    .page-content,
                    .wiki-content,
                    .post-content,
                    [role="main"],
                    .page-body,
                    .article-body,
                    .v-main,
                    .v-main__wrap,
                    .v-application--wrap,
                    .layout,
                    .v-application,
                    .application,
                    .container,
                    .container-fluid,
                    .v-container,
                    .v-container--fluid,
                    .content-wrapper,
                    .page,
                    .page__content,
                    .page-wrapper,
                    .markdown,
                    .markdown-body,
                    article,
                    .content__inner,
                    .page-content__inner,
                    .v-content,
                    .v-content__wrap,
                    .v-application__wrap,
                    .v-application .v-content,
                    .v-application .v-content__wrap,
                    .page-col-content,
                    .flex.page-col-content,
                    .layout.row > .page-col-content,
                    .layout.row > .flex.page-col-content,
                    .layout.row > .flex.lg9,
                    .layout.row > .flex.xl10,
                    .layout.row > .flex.lg9.xl10,
                    .layout.row > .flex.xs12.lg9.xl10,
                    .flex.lg9,
                    .flex.xl10,
                    .flex.lg9.xl10,
                    .flex.xs12.lg9.xl10,
                    .contents,
                    .wiki-page,
                    .wiki-page-content {
                        margin: 0 !important;
                        padding: 0 !important;
                        width: 100% !important;
                        max-width: none !important;
                        float: none !important;
                        left: auto !important;
                        right: auto !important;
                        transform: none !important;
                        box-sizing: border-box !important;
                    }
                .page-col-content,
                .flex.page-col-content,
                .layout.row > .page-col-content,
                .layout.row > .flex.page-col-content,
                .layout.row > .flex.lg9,
                .layout.row > .flex.xl10,
                .layout.row > .flex.lg9.xl10,
                .layout.row > .flex.xs12.lg9.xl10,
                .flex.lg9,
                .flex.xl10,
                .flex.lg9.xl10,
                .flex.xs12.lg9.xl10,
                .contents {
                    flex: 0 0 100% !important;
                    flex-basis: 100% !important;
                    max-width: 100% !important;
                }
                    [data-export-layout-chain="1"] {
                        width: 100% !important;
                        max-width: none !important;
                        min-width: 0 !important;
                        margin-left: 0 !important;
                        margin-right: 0 !important;
                        box-sizing: border-box !important;
                    }
                    [data-export-layout-root="1"] {
                        width: ${printContentWidthMm}mm !important;
                        max-width: ${printContentWidthMm}mm !important;
                        min-width: 0 !important;
                        margin-left: auto !important;
                        margin-right: auto !important;
                        padding-left: 0 !important;
                        padding-right: 0 !important;
                        box-sizing: border-box !important;
                    }
                    [data-export-layout-root="1"] * {
                        min-width: 0 !important;
                        box-sizing: border-box !important;
                    }
                    body { color: inherit !important; font-family: inherit !important; ${bodyFontSizeRule} -webkit-print-color-adjust: exact; print-color-adjust: exact; }
                    img { max-width: 100% !important; height: auto !important; }
                    img, figure, svg, .image, .media, .v-image, pre, code, blockquote {
                        break-inside: avoid !important;
                        page-break-inside: avoid !important;
                    }
                    table {
                        width: 100% !important;
                        max-width: 100% !important;
                        table-layout: auto !important;
                        break-inside: auto !important;
                        page-break-inside: auto !important;
                        break-before: auto !important;
                        page-break-before: auto !important;
                        break-after: auto !important;
                        page-break-after: auto !important;
                    }
                    table, table * {
                        box-sizing: border-box !important;
                    }
                    table thead, table tbody, table tfoot, table tr {
                        break-inside: auto !important;
                        page-break-inside: auto !important;
                        break-before: auto !important;
                        page-break-before: auto !important;
                    }
                    table tr, table td, table th {
                        break-inside: avoid !important;
                        page-break-inside: avoid !important;
                    }
                    th, td { word-break: break-word !important; overflow-wrap: anywhere !important; min-width: 0 !important; }
                    td, th { vertical-align: middle; }
                    pre, code { white-space: pre-wrap !important; word-break: break-word !important; }
                    /* Better vertical alignment of images inside table cells */
                    td > img:only-child,
                    th > img:only-child {
                        vertical-align: middle !important;
                        display: inline-block !important;
                    }
                    table img {
                        max-width: 100% !important;
                        height: auto !important;
                        object-fit: contain !important;
                    }
                    table[data-export-media-table="1"] img {
                        max-width: 100% !important;
                        height: auto !important;
                    }
                    table[data-export-overflow-table="1"] {
                        width: 100% !important;
                        max-width: 100% !important;
                        table-layout: fixed !important;
                    }
                    table[data-export-overflow-table="1"] col,
                    table[data-export-overflow-table="1"] colgroup {
                        width: auto !important;
                    }
                    table[data-export-overflow-table="1"] td,
                    table[data-export-overflow-table="1"] th {
                        min-width: 0 !important;
                        overflow-wrap: anywhere !important;
                        word-break: break-word !important;
                    }
                    table[data-export-overflow-table="1"] img {
                        display: block !important;
                        margin-left: auto !important;
                        margin-right: auto !important;
                        max-width: 100% !important;
                        height: auto !important;
                    }

                    /* Avoid orphan headings at bottom of page and keep multi-line headings together */
                    h1, h2, h3, h4, h5, h6 {
                        page-break-after: avoid !important;
                        break-after: avoid-page !important;
                        page-break-inside: avoid !important;
                        break-inside: avoid-page !important;
                    }
                    .export-heading-group {
                        page-break-inside: avoid !important;
                        break-inside: avoid !important;
                        margin: 0 !important;
                        padding: 0 !important;
                    }
                    /* Keep italics that are part of headings/emphasis */
                    h1 em, h2 em, h3 em, h4 em, h5 em, h6 em,
                    h1 i,  h2 i,  h3 i,  h4 i,  h5 i,  h6 i {
                        font-style: italic !important;
                        font-weight: inherit !important;
                    }
                    /* Ensure inline italics remain italic */
                    em, i { font-style: italic !important; font-weight: inherit !important; }
                    /* Allow Chrome to synthesize italic when the font lacks an italic face (common in PDFs) */
                    h1, h2, h3, h4, h5, h6, em, i { font-synthesis: style; }
                    /* Keep warning/info/admonition boxes together */
                    .alert, .v-alert, .warning, .info, .note, .tip, .admonition, .callout, .notification {
                        page-break-inside: avoid !important;
                        break-inside: avoid-page !important;
                    }
                    /* Make multi-line links highlight as one unit */
                    a {
                        display: inline-block;
                        max-width: 100%;
                        text-decoration-thickness: auto;
                        text-decoration-skip-ink: auto;
                        box-decoration-break: slice;
                        -webkit-box-decoration-break: slice;
                    }
                    a:hover, a:focus {
                        background-color: rgba(0, 123, 255, 0.12);
                        text-decoration: underline;
                        outline: none;
                    }
                    a:focus-visible {
                        outline: 2px solid rgba(0, 123, 255, 0.35);
                        outline-offset: 2px;
                    }
                    .export-toc {
                        break-after: page;
                        page-break-after: always;
                        display: flex;
                        flex-direction: column;
                        align-items: center;
                        width: 100%;
                        margin: 0 auto;
                        text-align: center;
                    }
                    .export-cover {
                        break-after: page;
                        page-break-after: always;
                        display: flex;
                        flex-direction: column;
                        align-items: center;
                        justify-content: center;
                        min-height: calc(100vh - 2cm);
                        text-align: center;
                    }
                    .export-toc-title {
                        font-size: 24px;
                        font-weight: 700;
                        margin: 0 0 12px;
                        text-align: center;
                        width: 100%;
                        color: var(--export-h1-color, inherit);
                    }
                    .export-toc-list {
                        list-style: none;
                        padding: 0;
                        margin: 0;
                        width: 75%;
                        margin-left: auto;
                        margin-right: auto;
                        text-align: left;
                    }
                    .export-toc-item {
                        margin: 0 0 6px;
                    }
                    .export-toc-item.h2 {
                        margin-left: 18px;
                    }
                    .export-toc-link {
                        display: flex;
                        align-items: baseline;
                        gap: 8px;
                        width: 100%;
                        color: var(--export-link-color, #0066cc);
                        text-decoration: none;
                    }
                    .export-toc-item.h1 .export-toc-link {
                        color: var(--export-link-color, #0066cc);
                        font-weight: 700;
                    }
                    .export-toc-dots {
                        flex: 1 1 auto;
                        border-bottom: 1px dotted rgba(0, 0, 0, 0.35);
                        margin: 0 6px;
                    }
                    .export-toc-page {
                        min-width: 2ch;
                        text-align: right;
                    }
                }
            `;
            document.head.appendChild(style);
        }, this.config.fontSize, printableContentWidthMm);

        const setDynamicPageMargins = async (bottomMarginCss) => {
            await this.page.evaluate((resolvedBottomMargin) => {
                let dynamicStyle = document.getElementById('export-dynamic-page-margin');
                if (!dynamicStyle) {
                    dynamicStyle = document.createElement('style');
                    dynamicStyle.id = 'export-dynamic-page-margin';
                    document.head.appendChild(dynamicStyle);
                }
                dynamicStyle.textContent = `
                    @page {
                        size: A4;
                        margin: 2cm 1cm ${resolvedBottomMargin} 1cm;
                    }
                `;
            }, bottomMarginCss);
        };
        await setDynamicPageMargins(marginState.bottomMarginCss);

        const disableAutoWidenContent = false;
        // Build a stable content root/chain so oversized descendants (wide media in tables)
        // cannot stretch layout and trigger global text downscaling.
        if (!disableAutoWidenContent) await this.page.evaluate((printContentWidthMm) => {
            document.querySelectorAll('[data-export-layout-root], [data-export-layout-chain]').forEach(el => {
                el.removeAttribute('data-export-layout-root');
                el.removeAttribute('data-export-layout-chain');
            });

            const bodyWidth = document.documentElement.clientWidth || document.body.clientWidth || 0;
            if (!bodyWidth) return;

            const candidates = Array.from(document.querySelectorAll(
                '.contents, .page-col-content, main, article, .main-content, .content, .article-content, ' +
                '.page-content, .wiki-content, .page-body, .article-body, .markdown, .markdown-body, ' +
                '.wiki-page, .wiki-page-content, .content__inner, .page-content__inner, .v-content, ' +
                '.v-content__wrap, .container, .container-fluid'
            )).filter(el => {
                const rect = el.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0;
            });

            const score = el => {
                const rect = el.getBoundingClientRect();
                const textLength = (el.innerText || '').trim().length;
                const headings = el.querySelectorAll('h1, h2, h3, h4, h5, h6').length;
                const paragraphs = el.querySelectorAll('p, li').length;
                const cs = window.getComputedStyle(el);
                const maxW = cs.maxWidth;
                const hasMax = !!maxW && maxW !== 'none' && maxW !== '0px';
                const widthPenalty = rect.width < bodyWidth * 0.55 ? -800 : 0;
                return textLength + (paragraphs * 30) + (headings * 80) + (hasMax ? 200 : 0) + widthPenalty;
            };

            const root = candidates.sort((a, b) => score(b) - score(a))[0] || document.querySelector('main') || document.body;
            if (!root) return;

            root.setAttribute('data-export-layout-root', '1');
            let chain = root;
            while (chain && chain !== document.documentElement) {
                chain.setAttribute('data-export-layout-chain', '1');
                chain = chain.parentElement;
            }

            root.style.setProperty('width', `${printContentWidthMm}mm`, 'important');
            root.style.setProperty('max-width', `${printContentWidthMm}mm`, 'important');
            root.style.setProperty('min-width', '0', 'important');
            root.style.setProperty('margin-left', 'auto', 'important');
            root.style.setProperty('margin-right', 'auto', 'important');
            root.style.setProperty('padding-left', '0', 'important');
            root.style.setProperty('padding-right', '0', 'important');
            root.style.setProperty('float', 'none', 'important');

            // Hard override for Vuetify column constraints.
            const cols = Array.from(document.querySelectorAll(
                '.page-col-content, .flex.page-col-content, .layout.row > .page-col-content, ' +
                '.layout.row > .flex.page-col-content, .layout.row > .flex.lg9, .layout.row > .flex.xl10, ' +
                '.layout.row > .flex.lg9.xl10, .layout.row > .flex.xs12.lg9.xl10, ' +
                '.flex.lg9, .flex.xl10, .flex.lg9.xl10, .flex.xs12.lg9.xl10'
            ));
            cols.forEach(el => {
                el.style.setProperty('width', '100%', 'important');
                el.style.setProperty('max-width', '100%', 'important');
                el.style.setProperty('min-width', '0', 'important');
                el.style.setProperty('flex', '0 0 100%', 'important');
                el.style.setProperty('flex-basis', '100%', 'important');
            });
        }, printableContentWidthMm);

        const disableOverflowTableNormalization = false;
        // Apply stronger constraints only to tables that still overflow page width.
        if (!disableOverflowTableNormalization) await this.page.evaluate(() => {
            const root = document.querySelector('[data-export-layout-root="1"]') || document.body;
            const rootRect = root.getBoundingClientRect();
            const limitWidth = rootRect.width || document.documentElement.clientWidth || document.body.clientWidth || 0;
            if (!limitWidth) return;

            const tables = Array.from(document.querySelectorAll('table')).filter(t => t.offsetParent);
            tables.forEach(table => {
                table.removeAttribute('data-export-overflow-table');
            });

            const isOverflowing = (table) => {
                const rect = table.getBoundingClientRect();
                const visualWidth = rect.width || table.offsetWidth || 0;
                const scrollWidth = table.scrollWidth || 0;
                return visualWidth > limitWidth + 1 || scrollWidth > limitWidth + 1;
            };

            tables.forEach(table => {
                if (!isOverflowing(table)) return;
                table.setAttribute('data-export-overflow-table', '1');
                table.style.setProperty('width', '100%', 'important');
                table.style.setProperty('max-width', '100%', 'important');
                table.style.setProperty('table-layout', 'fixed', 'important');

                table.querySelectorAll('colgroup, col').forEach(col => {
                    col.style.setProperty('width', 'auto', 'important');
                });

                table.querySelectorAll('td, th').forEach(cell => {
                    cell.style.setProperty('min-width', '0', 'important');
                    cell.style.setProperty('overflow-wrap', 'anywhere', 'important');
                    cell.style.setProperty('word-break', 'break-word', 'important');
                });

                table.querySelectorAll('img, figure, svg, .image, .media, .v-image').forEach(media => {
                    media.style.setProperty('max-width', '100%', 'important');
                    media.style.setProperty('height', 'auto', 'important');
                    if (media.tagName && media.tagName.toLowerCase() === 'img') {
                        media.style.setProperty('display', 'block', 'important');
                        media.style.setProperty('margin-left', 'auto', 'important');
                        media.style.setProperty('margin-right', 'auto', 'important');
                    }
                });
            });
        });

        const debugContentWidth = false;
        if (debugContentWidth) {
            const debugInfo = await this.page.evaluate(() => {
                const bodyWidth = document.documentElement.clientWidth || document.body.clientWidth || 0;
                const pickInfo = el => {
                    const rect = el.getBoundingClientRect();
                    const cs = window.getComputedStyle(el);
                    return {
                        tag: el.tagName.toLowerCase(),
                        id: el.id || '',
                        class: el.className || '',
                        width: rect.width || 0,
                        maxWidth: cs.maxWidth || '',
                        marginLeft: cs.marginLeft || '',
                        marginRight: cs.marginRight || '',
                        fontSize: cs.fontSize || '',
                        lineHeight: cs.lineHeight || ''
                    };
                };
                const scaleIssues = [];
                const all = Array.from(document.querySelectorAll('body *'));
                for (const el of all) {
                    const cs = window.getComputedStyle(el);
                    const zoom = cs.zoom || '1';
                    const transform = cs.transform || 'none';
                    const fontSize = cs.fontSize || '';
                    if ((zoom && zoom !== '1' && zoom !== 'normal') || (transform && transform !== 'none')) {
                        const rect = el.getBoundingClientRect();
                        scaleIssues.push({
                            tag: el.tagName.toLowerCase(),
                            id: el.id || '',
                            class: el.className || '',
                            zoom,
                            transform,
                            fontSize,
                            width: rect.width || 0
                        });
                    }
                }
                scaleIssues.sort((a, b) => b.width - a.width);
                const selectors = [
                    'main', 'article', '.main-content', '.content', '.article-content', '.page-content',
                    '.wiki-content', '.page-body', '.article-body', '.markdown', '.markdown-body',
                    '.wiki-page', '.wiki-page-content', '.content__inner', '.page-content__inner',
                    '.v-content', '.v-content__wrap', '.container', '.container-fluid'
                ];
                const list = [];
                selectors.forEach(sel => {
                    document.querySelectorAll(sel).forEach(el => list.push({ selector: sel, ...pickInfo(el) }));
                });
                list.sort((a, b) => b.width - a.width);

                const narrowTextBlocks = [];
                for (const el of all) {
                    const tag = el.tagName.toLowerCase();
                    if (['script', 'style', 'noscript', 'svg'].includes(tag)) continue;
                    const text = (el.textContent || '').trim();
                    if (text.length < 200) continue;
                    const rect = el.getBoundingClientRect();
                    if (rect.width <= 0) continue;
                    if (rect.width < bodyWidth * 0.85) {
                        const cs = window.getComputedStyle(el);
                        narrowTextBlocks.push({
                            tag,
                            id: el.id || '',
                            class: el.className || '',
                            width: rect.width || 0,
                            maxWidth: cs.maxWidth || '',
                            paddingLeft: cs.paddingLeft || '',
                            paddingRight: cs.paddingRight || '',
                            marginLeft: cs.marginLeft || '',
                            marginRight: cs.marginRight || '',
                            fontSize: cs.fontSize || ''
                        });
                    }
                }
                narrowTextBlocks.sort((a, b) => a.width - b.width);

                const iframes = Array.from(document.querySelectorAll('iframe')).map(el => {
                    const rect = el.getBoundingClientRect();
                    return { width: rect.width || 0, height: rect.height || 0, src: el.getAttribute('src') || '' };
                });
                const narrowTargetEl = (() => {
                    let best = null;
                    let bestWidth = Infinity;
                    for (const el of all) {
                        const tag = el.tagName.toLowerCase();
                        if (['script', 'style', 'noscript', 'svg'].includes(tag)) continue;
                        const text = (el.textContent || '').trim();
                        if (text.length < 200) continue;
                        const rect = el.getBoundingClientRect();
                        if (rect.width <= 0) continue;
                        if (rect.width < bodyWidth * 0.85 && rect.width < bestWidth) {
                            best = el;
                            bestWidth = rect.width;
                        }
                    }
                    return best;
                })();
                const narrowChain = [];
                let nc = narrowTargetEl;
                let ndepth = 0;
                while (nc && ndepth < 10) {
                    narrowChain.push(pickInfo(nc));
                    nc = nc.parentElement;
                    ndepth += 1;
                }
                // Find a text-dense element and walk its parents to locate width constraints.
                const textCandidates = all.filter(el => {
                    const tag = el.tagName.toLowerCase();
                    if (['script', 'style', 'noscript', 'svg'].includes(tag)) return false;
                    const text = (el.textContent || '').trim();
                    return text.length > 200;
                });
                textCandidates.sort((a, b) => (b.textContent || '').length - (a.textContent || '').length);
                const textTarget = textCandidates[0] || null;
                const chain = [];
                let cur = textTarget;
                let depth = 0;
                while (cur && depth < 8) {
                    chain.push(pickInfo(cur));
                    cur = cur.parentElement;
                    depth += 1;
                }
                const rootInfo = {
                    html: pickInfo(document.documentElement),
                    body: pickInfo(document.body)
                };
                const key = sel => {
                    const el = document.querySelector(sel);
                    if (!el) return null;
                    const rect = el.getBoundingClientRect();
                    const cs = window.getComputedStyle(el);
                    return {
                        sel,
                        width: rect.width || 0,
                        maxWidth: cs.maxWidth || '',
                        flexBasis: cs.flexBasis || '',
                        flex: cs.flex || '',
                        display: cs.display || '',
                        transform: cs.transform || '',
                        zoom: cs.zoom || ''
                    };
                };
                return {
                    bodyWidth,
                    top: list.slice(0, 6),
                    scaleIssues: scaleIssues.slice(0, 8),
                    narrowTextBlocks: narrowTextBlocks.slice(0, 8),
                    narrowChain,
                    iframes,
                    textChain: chain,
                    rootInfo,
                    keyBlocks: [
                        key('.contents'),
                        key('.page-col-content'),
                        key('.layout.row'),
                        key('.flex.page-col-content'),
                        key('.flex.lg9'),
                        key('.flex.xl10')
                    ]
                };
            });
            console.log('CONTENT-WIDTH-DEBUG', JSON.stringify(debugInfo));
        }

        const disableTableBreaks = Boolean(this.config.disableTableBreaks);
        // Push large tables (and their immediate headings) to the next page when too little space remains
        if (!disableTableBreaks) await this.page.evaluate(() => {
            const inch = 96;
            const pageHeightPx = 11.69 * inch; // A4 height in px at 96dpi
            const marginTopPx = 75.6; // 2cm top margin used in PDF
            const marginBottomPx = 37.8; // 1cm bottom margin used in PDF
            const usableHeight = pageHeightPx - marginTopPx - marginBottomPx;
            const lineHeight = parseFloat(getComputedStyle(document.body).lineHeight) || 16;
            const keepBuffer = lineHeight * 2;

            const tables = Array.from(document.querySelectorAll('table')).filter(t => t.offsetParent);
            const forcedBreakTables = new Set();

            tables.forEach(table => {
                const rect = table.getBoundingClientRect();
                const tableHeight = rect.height || 0;
                const top = rect.top + window.scrollY;
                const pageIndex = Math.max(0, Math.floor((top - marginTopPx) / usableHeight));
                const currentPageBottom = marginTopPx + (pageIndex + 1) * usableHeight;
                const spaceLeft = currentPageBottom - top;

                // Reset any previous forced breaks so we can re-evaluate per layout.
                table.style.breakBefore = '';
                table.style.pageBreakBefore = '';
                table.style.breakInside = 'auto';
                table.style.pageBreakInside = 'auto';

                // Normalize nested sections/rows to avoid inherited page-break rules from site CSS.
                ['thead', 'tbody', 'tfoot', 'tr'].forEach(sel => {
                    table.querySelectorAll(sel).forEach(el => {
                        el.style.breakBefore = '';
                        el.style.pageBreakBefore = '';
                        el.style.breakInside = 'auto';
                        el.style.pageBreakInside = 'auto';
                    });
                });

                // If only the first logical row fits at the end of the page, move the table.
                const rows = Array.from(table.rows || table.querySelectorAll('tr'));
                let firstLogicalRow = null;
                let firstLogicalRect = null;
                let secondLogicalRow = null;
                let secondLogicalRect = null;
                for (const row of rows) {
                    const rect = row.getBoundingClientRect();
                    if (!rect.height) continue;
                    if (!firstLogicalRow) {
                        firstLogicalRow = row;
                        firstLogicalRect = rect;
                        continue;
                    }
                    if (!secondLogicalRow) {
                        secondLogicalRow = row;
                        secondLogicalRect = rect;
                        break;
                    }
                }
                if (firstLogicalRow && secondLogicalRow && firstLogicalRect && secondLogicalRect) {
                    const firstTop = firstLogicalRect.top + window.scrollY;
                    const firstBottom = firstTop + firstLogicalRect.height;
                    const secondTop = secondLogicalRect.top + window.scrollY;
                    const rowPageIndex = Math.max(0, Math.floor((firstTop - marginTopPx) / usableHeight));
                    const rowPageBottom = marginTopPx + (rowPageIndex + 1) * usableHeight;
                    const epsilon = Math.max(2, lineHeight * 0.25);
                    const firstFits = firstBottom <= rowPageBottom + epsilon;
                    const secondStartsNext = secondTop >= rowPageBottom - epsilon;
                    if (firstFits && secondStartsNext) {
                        table.style.breakBefore = 'page';
                        table.style.pageBreakBefore = 'always';
                        table.setAttribute('data-forced-page-break', 'before');
                        forcedBreakTables.add(table);
                        return;
                    }
                }

            const rowEls = Array.from(table.querySelectorAll('tbody tr'));
            const headRow = table.querySelector('thead tr');
            const visibleRows = rowEls.length ? rowEls : Array.from(table.querySelectorAll('tr'));
            const firstRows = visibleRows.slice(0, 2);
            const rowsHeight = firstRows.reduce((sum, row) => sum + (row.getBoundingClientRect().height || 0), 0);
            const headHeight = headRow ? (headRow.getBoundingClientRect().height || 0) : 0;
            const minStartHeight = headHeight + rowsHeight;
            const firstRow = visibleRows[0] || null;
            const secondRow = visibleRows[1] || null;
            const firstRowHeight = firstRow ? (firstRow.getBoundingClientRect().height || 0) : 0;
            const secondRowHeight = secondRow ? (secondRow.getBoundingClientRect().height || 0) : 0;
            const minFirstRowHeight = headHeight + firstRowHeight;
            const minTwoRowsHeight = minFirstRowHeight + secondRowHeight;

            // If only the first row fits, move the whole table to the next page.
            if (secondRow && minTwoRowsHeight > 0 && spaceLeft < minTwoRowsHeight) {
                table.style.breakBefore = 'page';
                table.style.pageBreakBefore = 'always';
                table.setAttribute('data-forced-page-break', 'before');
                forcedBreakTables.add(table);
                return;
            }
            if (tableHeight > spaceLeft && minStartHeight > 0 && spaceLeft < minStartHeight) {
                table.style.breakBefore = 'page';
                table.style.pageBreakBefore = 'always';
                table.setAttribute('data-forced-page-break', 'before');
                forcedBreakTables.add(table);
                return;
            }
                // If the table fits in the remaining space, keep it on this page.
                if (tableHeight <= spaceLeft) {
                    return;
                }
            });

            // If a heading is immediately followed by a table that is forced to next page, move the heading too
            const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6'));
            headings.forEach(h => {
                h.style.breakBefore = '';
                h.style.pageBreakBefore = '';
                let next = h.nextElementSibling;
                while (next && next.textContent.trim() === '' && !next.querySelector('img,table,video,pre,code')) {
                    next = next.nextElementSibling;
                }
                if (next && next.tagName === 'TABLE' && forcedBreakTables.has(next)) {
                    h.style.breakBefore = 'page';
                    h.style.pageBreakBefore = 'always';
                    h.setAttribute('data-forced-page-break', 'before');
                }
            });
        });

        // Prevent table rows from splitting across pages by forcing a page break before
        // any row that would cross a page boundary.
        if (!disableTableBreaks) await this.page.evaluate(() => {
            const inch = 96;
            const pageHeightPx = 11.69 * inch;
            const marginTopPx = 75.6; // 2cm top margin used in PDF
            const marginBottomPx = 37.8; // 1cm bottom margin used in PDF
            const usableHeight = pageHeightPx - marginTopPx - marginBottomPx;
            const lineHeight = parseFloat(getComputedStyle(document.body).lineHeight) || 16;
            const keepBuffer = lineHeight * 2;
            const findPrevHeading = (table) => {
                let prev = table.previousElementSibling;
                while (prev && prev.textContent.trim() === '' && !prev.querySelector('img,table,video,pre,code')) {
                    prev = prev.previousElementSibling;
                }
                if (prev && /^H[1-6]$/.test(prev.tagName)) return prev;
                return null;
            };

            const tables = Array.from(document.querySelectorAll('table')).filter(t => t.offsetParent);
            tables.forEach(table => {
                const rows = Array.from(table.querySelectorAll('tbody tr'));
                rows.forEach((row, idx) => {
                    const rect = row.getBoundingClientRect();
                    if (!rect.height) return;
                    if (rect.height > usableHeight) return; // can't avoid split for oversized rows

                    const top = rect.top + window.scrollY;
                    const bottom = top + rect.height;
                    const pageIndex = Math.max(0, Math.floor((top - marginTopPx) / usableHeight));
                    const pageBottom = marginTopPx + (pageIndex + 1) * usableHeight;

                    if (bottom > pageBottom) {
                        if (idx === 0) {
                            const tableStyle = window.getComputedStyle(table);
                            const alreadyForced =
                                table.getAttribute('data-forced-page-break') === 'before' ||
                                tableStyle.breakBefore === 'page' ||
                                tableStyle.breakBefore === 'always' ||
                                tableStyle.pageBreakBefore === 'always';
                            if (!alreadyForced) {
                                const target = findPrevHeading(table) || table;
                                target.style.breakBefore = 'page';
                                target.style.pageBreakBefore = 'always';
                                target.setAttribute('data-forced-page-break', 'before');
                                table.setAttribute('data-forced-page-break', 'before');
                            }
                        } else {
                            row.style.breakBefore = 'page';
                            row.style.pageBreakBefore = 'always';
                            row.setAttribute('data-forced-page-break', 'before');
                        }
                    }
                });
            });
        });

        const disableHeadingBreaks = this.config.disableHeadingBreaks ?? true;
        // Keep multi-line headings with their following tables when there is not enough
        // space left on the page, to avoid splitting the heading across pages.
        if (!disableHeadingBreaks) await this.page.evaluate(() => {
            const inch = 96;
            const pageHeightPx = 11.69 * inch;
            const marginTopPx = 75.6; // 2cm top margin used in PDF
            const marginBottomPx = 37.8; // 1cm bottom margin used in PDF
            const usableHeight = pageHeightPx - marginTopPx - marginBottomPx;
            const lineHeight = parseFloat(getComputedStyle(document.body).lineHeight) || 16;
            const buffer = lineHeight * 2; // allow at least ~2 lines of space

            const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6'));
            headings.forEach(h => {
                const rect = h.getBoundingClientRect();
                const height = rect.height || 0;
                const top = rect.top + window.scrollY;
                const pageIndex = Math.max(0, Math.floor((top - marginTopPx) / usableHeight));
                const currentPageBottom = marginTopPx + (pageIndex + 1) * usableHeight;
                const spaceLeft = currentPageBottom - top;

                let next = h.nextElementSibling;
                while (next && next.textContent.trim() === '' && !next.querySelector('img,table,video,pre,code')) {
                    next = next.nextElementSibling;
                }
                const nextIsTable = next && next.tagName === 'TABLE';

                if (nextIsTable && spaceLeft < height + buffer) {
                    h.style.breakBefore = 'page';
                    h.style.pageBreakBefore = 'always';
                    h.setAttribute('data-forced-page-break', 'before');
                }
            });
        });

        // If a heading is the last visible element on a page (next content starts on the
        // following page), move the heading to that next page.
        if (!disableHeadingBreaks) await this.page.evaluate(() => {
            const inch = 96;
            const pageHeightPx = 11.69 * inch;
            const marginTopPx = 75.6; // 2cm top margin used in PDF
            const marginBottomPx = 37.8; // 1cm bottom margin used in PDF
            const usableHeight = pageHeightPx - marginTopPx - marginBottomPx;

            const isRelevant = el => el && el.offsetParent && !['SCRIPT', 'STYLE'].includes(el.tagName);
            const isInTable = el => !!(el && el.closest && el.closest('table, thead, tbody, tfoot, tr, td, th'));

            const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6'));
            headings.forEach(h => {
                if (!isRelevant(h) || isInTable(h)) return;
                const rect = h.getBoundingClientRect();
                const top = rect.top + window.scrollY;
                const pageIndex = Math.max(0, Math.floor((top - marginTopPx) / usableHeight));
                const currentPageBottom = marginTopPx + (pageIndex + 1) * usableHeight;
                const cs = window.getComputedStyle(h);
                const lineHeight = parseFloat(cs.lineHeight) || 16;
                const bodyLineHeight = parseFloat(getComputedStyle(document.body).lineHeight) || lineHeight;
                const marginBottom = parseFloat(cs.marginBottom) || 0;
                const spaceLeft = currentPageBottom - top;
                const remainingAfterHeading = currentPageBottom - (top + rect.height + marginBottom);

                // If only the heading fits at the bottom of the page, move it to the next page.
                if (remainingAfterHeading < bodyLineHeight) {
                    h.style.breakBefore = 'page';
                    h.style.pageBreakBefore = 'always';
                    h.setAttribute('data-forced-page-break', 'before');
                    return;
                }

                let next = h.nextElementSibling;
                while (next && (!isRelevant(next) || next.textContent.trim() === '')) {
                    next = next.nextElementSibling;
                }
                if (!next) return;

                const nextStyle = window.getComputedStyle(next);
                const hasForcedBreak =
                    next.getAttribute('data-forced-page-break') === 'before' ||
                    nextStyle.breakBefore === 'page' ||
                    nextStyle.breakBefore === 'always' ||
                    nextStyle.pageBreakBefore === 'always';
                if (hasForcedBreak) {
                    h.style.breakBefore = 'page';
                    h.style.pageBreakBefore = 'always';
                    h.setAttribute('data-forced-page-break', 'before');
                    return;
                }

                const nextTop = next.getBoundingClientRect().top + window.scrollY;
                const nextPageIndex = Math.max(0, Math.floor((nextTop - marginTopPx) / usableHeight));
                if (nextPageIndex > pageIndex) {
                    h.style.breakBefore = 'page';
                    h.style.pageBreakBefore = 'always';
                    h.setAttribute('data-forced-page-break', 'before');
                }
            });
        });

        const disableHeadingPairGuard = Boolean(this.config.disableHeadingPairGuard);
        if (!disableHeadingPairGuard && disableHeadingBreaks) await this.page.evaluate(() => {
            const inch = 96;
            const pageHeightPx = 11.69 * inch;
            const marginTopPx = 75.6; // 2cm top margin used in PDF
            const marginBottomPx = 37.8; // 1cm bottom margin used in PDF
            const usableHeight = pageHeightPx - marginTopPx - marginBottomPx;

            const isRelevant = el => el && el.offsetParent && !['SCRIPT', 'STYLE'].includes(el.tagName);
            const isInTable = el => !!(el && el.closest && el.closest('table, thead, tbody, tfoot, tr, td, th'));
            const isInExportChrome = el => !!(el && el.closest && el.closest('#export-toc, #export-cover'));
            const hasRenderableContent = el => !!(el && el.querySelector && el.querySelector('img,table,video,pre,code,figure,svg,.image,.media'));
            const isSkippable = el => !isRelevant(el) || ((el.textContent || '').trim() === '' && !hasRenderableContent(el));

            const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6'));
            headings.forEach(h => {
                if (!isRelevant(h) || isInTable(h) || isInExportChrome(h)) return;
                const cs = window.getComputedStyle(h);
                const alreadyForced =
                    h.getAttribute('data-forced-page-break') === 'before' ||
                    cs.breakBefore === 'page' ||
                    cs.breakBefore === 'always' ||
                    cs.pageBreakBefore === 'always';
                if (alreadyForced) return;

                let next = h.nextElementSibling;
                while (next && isSkippable(next)) {
                    next = next.nextElementSibling;
                }
                if (!next || !/^H[1-6]$/.test(next.tagName)) return;

                const rect = h.getBoundingClientRect();
                if (!rect.height) return;
                const top = rect.top + window.scrollY;
                const pageIndex = Math.max(0, Math.floor((top - marginTopPx) / usableHeight));
                const nextTop = next.getBoundingClientRect().top + window.scrollY;
                const nextPageIndex = Math.max(0, Math.floor((nextTop - marginTopPx) / usableHeight));
                if (nextPageIndex > pageIndex) {
                    h.style.breakBefore = 'page';
                    h.style.pageBreakBefore = 'always';
                    h.setAttribute('data-forced-page-break', 'before');
                }
            });
        });

        const disableHeadingGroup = Boolean(this.config.disableHeadingGroup);
        if (!disableHeadingGroup && disableHeadingBreaks) await this.page.evaluate(() => {
            const isRelevant = el => el && el.offsetParent && !['SCRIPT', 'STYLE'].includes(el.tagName);
            const isInTable = el => !!(el && el.closest && el.closest('table, thead, tbody, tfoot, tr, td, th'));
            const isInExportChrome = el => !!(el && el.closest && el.closest('#export-toc, #export-cover'));
            const hasRenderableContent = el => !!(el && el.querySelector && el.querySelector('img,table,video,pre,code,figure,svg,.image,.media'));
            const isSkippable = el => !isRelevant(el) || ((el.textContent || '').trim() === '' && !hasRenderableContent(el));

            const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6'));
            headings.forEach(h => {
                if (!isRelevant(h) || isInTable(h) || isInExportChrome(h)) return;
                if (h.closest('.export-heading-group')) return;

                let next = h.nextElementSibling;
                while (next && isSkippable(next)) {
                    next = next.nextElementSibling;
                }
                if (!next || !/^H[1-6]$/.test(next.tagName)) return;

                const group = document.createElement('div');
                group.className = 'export-heading-group';
                h.parentElement.insertBefore(group, h);

                let node = h;
                while (node && /^H[1-6]$/.test(node.tagName)) {
                    const nextNode = node.nextElementSibling;
                    group.appendChild(node);
                    let peek = nextNode;
                    while (peek && isSkippable(peek)) {
                        peek = peek.nextElementSibling;
                    }
                    if (!peek || !/^H[1-6]$/.test(peek.tagName)) break;
                    node = peek;
                }
            });
        });
        const disableHeadingCleanup = false;
        // Remove leading pilcrow (¶) icons from headings so the PDF doesn't start with that symbol
        if (!disableHeadingCleanup) await this.page.evaluate(() => {
            const headings = document.querySelectorAll('h1, h2, h3, h4, h5, h6');
            headings.forEach(h => {
                h.querySelectorAll('a.header-anchor, a.anchor, .header-anchor, .anchor').forEach(a => a.remove());
                const pilcrowRegex = /^[\s\u00A0\u200B\u200C\u200D\uFEFF]*¶\s*/;
                for (const node of h.childNodes) {
                    if (node.nodeType !== Node.TEXT_NODE) continue;
                    const original = node.nodeValue || '';
                    const cleaned = original.replace(pilcrowRegex, '');
                    node.nodeValue = cleaned;
                    if (cleaned.trim() !== '' || original.trim() !== '') {
                        break;
                    }
                }
            });
        });

        // Wait for custom fonts to be ready to preserve italics/weights
        await this.page.evaluate(() => (document.fonts && document.fonts.ready) ? document.fonts.ready : Promise.resolve());

        // Force screen media so page uses its live styling (colors, italics, underlines)
        await this.page.emulateMediaType('screen');

        const disableItalicFixes = false;
        // Lock computed italics inside headings so print styles cannot flatten them.
        if (!disableItalicFixes) await this.page.evaluate(() => {
            const headings = document.querySelectorAll('h1, h2, h3, h4, h5, h6');
            headings.forEach(h => {
                const nodes = [h, ...h.querySelectorAll('*')];
                nodes.forEach(el => {
                    const cs = window.getComputedStyle(el);
                    if (cs && (cs.fontStyle === 'italic' || cs.fontStyle === 'oblique')) {
                        el.style.setProperty('font-style', 'italic', 'important');
                    }
                });
            });
        });

        // Force italics for explicit emphasis tags inside headings (overrides theme resets).
        // Apply a skew fallback because some PDF font subsets still drop italic faces.
        if (!disableItalicFixes) await this.page.evaluate(() => {
            const italicInHeadings = document.querySelectorAll(
                'h1 em, h2 em, h3 em, h4 em, h5 em, h6 em, h1 i, h2 i, h3 i, h4 i, h5 i, h6 i'
            );
            italicInHeadings.forEach(el => {
                el.style.setProperty('font-style', 'italic', 'important');
                el.style.setProperty('font-synthesis', 'style', 'important');
                el.style.setProperty('display', 'inline-block', 'important');
                el.style.setProperty('transform', 'skewX(-6deg)', 'important');
                el.style.setProperty('transform-origin', 'left bottom', 'important');
            });
        });

        // Ensure italic font faces are loaded before printing to PDF.
        if (!disableItalicFixes) await this.page.evaluate(async () => {
            if (!document.fonts || !document.fonts.load) return;
            const italicInHeadings = document.querySelectorAll(
                'h1 em, h2 em, h3 em, h4 em, h5 em, h6 em, h1 i, h2 i, h3 i, h4 i, h5 i, h6 i'
            );
            const loads = [];
            italicInHeadings.forEach(el => {
                const cs = window.getComputedStyle(el);
                if (!cs) return;
                const fontStyle = cs.fontStyle || 'italic';
                const fontWeight = cs.fontWeight || '400';
                const fontSize = cs.fontSize || '16px';
                const fontFamily = cs.fontFamily || '';
                if (!fontFamily) return;
                try {
                    loads.push(document.fonts.load(`${fontStyle} ${fontWeight} ${fontSize} ${fontFamily}`));
                } catch (_) { /* ignore */ }
            });
            if (loads.length) {
                await Promise.all(loads);
            }
        });

        if (hasCustomBaseFontSize) {
            // Keep explicit base font size stable; auto-scale can visually cancel it.
            pdfOptions.scale = 1;
        } else {
            // Compute a per-page PDF scale to normalize visual size across pages.
            const autoScale = await this.page.evaluate((printContentWidthMm) => {
                const root = document.querySelector('[data-export-layout-root="1"]');
                let measured = root ? (root.getBoundingClientRect().width || 0) : 0;
                if (!measured) {
                    const candidates = [
                        document.querySelector('.contents'),
                        document.querySelector('.page-col-content'),
                        document.querySelector('main'),
                        document.querySelector('article'),
                        document.querySelector('.markdown'),
                        document.querySelector('.markdown-body')
                    ].filter(Boolean);
                    candidates.forEach(el => {
                        const w = el.getBoundingClientRect().width || 0;
                        if (w > measured) measured = w;
                    });
                }
                if (!measured) {
                    measured = document.documentElement.clientWidth || document.body.clientWidth || 0;
                }
                const expected = printContentWidthMm * (96 / 25.4);
                if (!measured || !expected) return 1;
                let scale = expected / measured;
                if (!Number.isFinite(scale) || scale <= 0) return 1;
                if (Math.abs(1 - scale) < 0.03) return 1;
                // Keep normalization gentle so text readability remains stable.
                scale = Math.max(0.85, Math.min(1.15, scale));
                return scale;
            }, printableContentWidthMm);
            pdfOptions.scale = autoScale;
        }
        pdfOptionsNoHeader = { ...pdfOptions, displayHeaderFooter: false };
        pdfOptionsFinal = { ...pdfOptions, displayHeaderFooter: true, headerTemplate, footerTemplate };

        const disableAnchorNormalization = false;
        // Normalize in-page anchor links so PDF keeps internal destinations working.
        if (!disableAnchorNormalization) await this.page.evaluate(() => {
            const isInTable = el => !!(el && el.closest && el.closest('table, thead, tbody, tfoot, tr, td, th'));
            const withId = Array.from(document.querySelectorAll('[id]'));
            withId.forEach(el => {
                if (isInTable(el)) return;
                const id = el.getAttribute('id');
                if (!id) return;
                if (!el.getAttribute('name')) {
                    el.setAttribute('name', id);
                }
                const encoded = (() => {
                    try { return encodeURIComponent(id); } catch (_) { return ''; }
                })();
                if (encoded && !document.getElementById(encoded)) {
                    const alias = document.createElement('a');
                    alias.setAttribute('id', encoded);
                    alias.setAttribute('name', encoded);
                    alias.style.display = 'block';
                    alias.style.width = '0';
                    alias.style.height = '0';
                    alias.style.overflow = 'hidden';
                    el.parentElement.insertBefore(alias, el);
                }
            });

            // If an anchor id is applied to inline text inside a heading (e.g., *text*{#id}),
            // add a zero-size anchor at the start of the heading so PDF destinations work.
            const inlineTagged = Array.from(document.querySelectorAll('em[id], i[id], span[id], strong[id], b[id], a[id]'));
            const inlineIdToHeadingId = new Map();
            const inlineIdToHeadingIdLower = new Map();
            inlineTagged.forEach(el => {
                if (isInTable(el)) return;
                const id = el.getAttribute('id');
                if (!id) return;
                const heading = el.closest('h1, h2, h3, h4, h5, h6');
                if (!heading || isInTable(heading)) return;
                if (heading.id) {
                    inlineIdToHeadingId.set(id, heading.id);
                    inlineIdToHeadingIdLower.set(id.toLowerCase(), heading.id);
                    if (!heading.getAttribute('name')) {
                        heading.setAttribute('name', heading.id);
                    }
                }
                if (heading.querySelector(`span[data-anchor-for="${id}"]`)) return;

                const marker = document.createElement('span');
                marker.setAttribute('data-anchor-for', id);
                marker.setAttribute('id', id);
                marker.setAttribute('name', id);
                marker.style.display = 'inline-block';
                marker.style.width = '0';
                marker.style.height = '0';
                marker.style.overflow = 'hidden';
                heading.insertBefore(marker, heading.firstChild);

                // Also add a named anchor before the heading to improve PDF target resolution.
                if (!heading.previousElementSibling || heading.previousElementSibling.getAttribute('data-anchor-for') !== id) {
                    const anchor = document.createElement('a');
                    anchor.setAttribute('data-anchor-for', id);
                    anchor.setAttribute('id', id);
                    anchor.setAttribute('name', id);
                    anchor.style.display = 'block';
                    anchor.style.width = '0';
                    anchor.style.height = '0';
                    anchor.style.overflow = 'hidden';
                    heading.parentElement.insertBefore(anchor, heading);
                }

                const encoded = (() => {
                    try { return encodeURIComponent(id); } catch (_) { return ''; }
                })();
                if (encoded && !document.getElementById(encoded)) {
                    const alias = document.createElement('a');
                    alias.setAttribute('data-anchor-for', id);
                    alias.setAttribute('id', encoded);
                    alias.setAttribute('name', encoded);
                    alias.style.display = 'block';
                    alias.style.width = '0';
                    alias.style.height = '0';
                    alias.style.overflow = 'hidden';
                    heading.parentElement.insertBefore(alias, heading);
                }
            });

            const links = Array.from(document.querySelectorAll('a[href^=\"#\"]'));
            links.forEach(link => {
                if (isInTable(link)) return;
                const raw = link.getAttribute('href');
                if (!raw || raw === '#') return;
                const hash = raw.slice(1);
                const decoded = (() => {
                    try { return decodeURIComponent(hash); } catch (_) { return hash; }
                })();
                const headingId =
                    inlineIdToHeadingId.get(decoded) ||
                    inlineIdToHeadingIdLower.get(decoded.toLowerCase());
                if (headingId) {
                    link.setAttribute('href', `#${headingId}`);
                    return;
                }
                const target = document.getElementById(hash) || document.getElementById(decoded);
                if (target && !isInTable(target)) {
                    const targetId = target.getAttribute('id');
                    link.setAttribute('href', `#${targetId}`);
                    if (!target.getAttribute('name')) {
                        target.setAttribute('name', targetId);
                    }
                }
            });
        });

        const footnoteMarkerPrefix = '__FOOTNOTE_REF_MARKER__';
        const footnoteMarkerSuffix = '__END__';
        const footnoteExtraction = await this.page.evaluate((refMarkerPrefix, refMarkerSuffix) => {
            const decodeHash = (href) => {
                if (!href || href === '#') return null;
                const raw = href.startsWith('#') ? href.slice(1) : href;
                if (!raw) return null;
                try {
                    return decodeURIComponent(raw);
                } catch (_) {
                    return raw;
                }
            };

            const ensureMarkerStyle = () => {
                if (document.getElementById('export-footnote-marker-style')) return;
                const style = document.createElement('style');
                style.id = 'export-footnote-marker-style';
                style.textContent = `
                    .export-footnote-ref-marker {
                        position: absolute;
                        left: 0;
                        top: 0;
                        font-size: 2px;
                        line-height: 2px;
                        opacity: 0.02;
                        color: rgba(0, 0, 0, 0.02);
                        pointer-events: none;
                    }
                `;
                document.head.appendChild(style);
            };

            const serializeDefinition = (element) => {
                if (!element) return [];
                const clone = element.cloneNode(true);
                clone.querySelectorAll('script, style, noscript').forEach(node => node.remove());
                clone.querySelectorAll('.footnote-backref, a.footnote-backref').forEach(node => node.remove());
                clone.querySelectorAll('a[href^="#fnref"], a[href*="#fnref"]').forEach(node => node.remove());

                const firstChild = clone.firstElementChild;
                if (firstChild && firstChild.tagName && firstChild.tagName.toLowerCase() === 'sup') {
                    firstChild.remove();
                }

                const segments = [];
                const blockTags = new Set(['P', 'DIV', 'LI', 'SECTION', 'ARTICLE', 'UL', 'OL', 'TABLE', 'TR', 'TD', 'TH', 'BLOCKQUOTE']);
                const skipTags = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT']);

                const pushSegment = (text, href) => {
                    const raw = String(text || '');
                    if (!raw) return;
                    const normalized = raw
                        .replace(/\u00A0/g, ' ')
                        .replace(/[ \t\f\v]+/g, ' ')
                        .replace(/\n{3,}/g, '\n\n');
                    if (!normalized) return;
                    const hrefValue = (typeof href === 'string' && href.trim()) ? href.trim() : null;
                    const last = segments[segments.length - 1];
                    if (last && last.href === hrefValue) {
                        last.text += normalized;
                    } else {
                        segments.push({ text: normalized, href: hrefValue });
                    }
                };

                const walk = (node, activeHref) => {
                    if (!node) return;
                    if (node.nodeType === Node.TEXT_NODE) {
                        pushSegment(node.nodeValue, activeHref);
                        return;
                    }
                    if (node.nodeType !== Node.ELEMENT_NODE) return;

                    const tag = String(node.tagName || '').toUpperCase();
                    if (!tag || skipTags.has(tag)) return;
                    if (node.classList && node.classList.contains('footnote-backref')) return;
                    if (tag === 'A' && /^#fnref/i.test(node.getAttribute('href') || '')) return;
                    if (tag === 'BR') {
                        pushSegment('\n', null);
                        return;
                    }

                    const isBlock = blockTags.has(tag);
                    if (isBlock) pushSegment('\n', null);

                    let nextHref = activeHref;
                    if (tag === 'A') {
                        const rawHref = String(node.getAttribute('href') || '').trim();
                        if (rawHref) {
                            if (rawHref.startsWith('#')) {
                                nextHref = rawHref;
                            } else {
                                try {
                                    nextHref = new URL(rawHref, window.location.href).href;
                                } catch (_) {
                                    nextHref = rawHref;
                                }
                            }
                        }
                    }

                    Array.from(node.childNodes).forEach(child => walk(child, nextHref));
                    if (isBlock) pushSegment('\n', null);
                };

                walk(clone, null);

                const compact = [];
                segments.forEach(segment => {
                    const normalizedText = String(segment.text || '').replace(/\n{3,}/g, '\n\n');
                    if (!normalizedText) return;
                    if (!normalizedText.replace(/\s+/g, '').trim()) return;
                    const last = compact[compact.length - 1];
                    if (last && last.href === segment.href) {
                        last.text += normalizedText;
                    } else {
                        compact.push({
                            text: normalizedText,
                            href: segment.href || null
                        });
                    }
                });

                if (!compact.length) {
                    const fallback = String(clone.textContent || '').replace(/\s+/g, ' ').trim();
                    if (fallback) {
                        compact.push({ text: fallback, href: null });
                    }
                }
                return compact;
            };

            ensureMarkerStyle();
            document.querySelectorAll('.export-footnote-ref-marker').forEach(node => node.remove());
            document.querySelectorAll('a[data-export-footnote-ref-index]').forEach(link => {
                link.removeAttribute('data-export-footnote-ref-index');
                link.removeAttribute('data-export-footnote-target-id');
            });

            const definitionsById = new Map();
            const registerDefinition = (id, element) => {
                if (!id || !element) return;
                if (!definitionsById.has(id)) {
                    definitionsById.set(id, element);
                }
            };

            Array.from(document.querySelectorAll('section.footnotes li[id]')).forEach(node => {
                registerDefinition(node.getAttribute('id'), node);
            });

            Array.from(document.querySelectorAll('[id]')).forEach(node => {
                const id = node.getAttribute('id');
                if (!id) return;
                const looksLikeFootnote =
                    /^footnote-\d+/i.test(id) ||
                    (node.classList && node.classList.contains('footnote-item')) ||
                    Boolean(node.closest && node.closest('section.footnotes'));
                if (looksLikeFootnote) {
                    registerDefinition(id, node);
                }
            });

            const refs = [];
            let refIndex = 0;
            const hashLinks = Array.from(document.querySelectorAll('a[href^="#"]'));
            hashLinks.forEach(link => {
                const rawHref = String(link.getAttribute('href') || '');
                if (!rawHref || rawHref === '#') return;
                const targetId = decodeHash(rawHref);
                if (!targetId) return;

                const target = document.getElementById(targetId) || document.getElementById(encodeURIComponent(targetId));
                const refLooksLikeFootnote = Boolean(link.closest('sup, .footnote-ref'));
                const fnIdPatternMatch = /^fn\d+$/i.test(targetId);
                const targetLooksLikeFootnote = Boolean(
                    target && (
                        (target.closest && target.closest('section.footnotes')) ||
                        /^footnote-\d+/i.test(targetId) ||
                        (fnIdPatternMatch && refLooksLikeFootnote) ||
                        (target.classList && target.classList.contains('footnote-item'))
                    )
                );

                if (!targetLooksLikeFootnote && !refLooksLikeFootnote) return;
                if (target) registerDefinition(targetId, target);
                if (!definitionsById.has(targetId)) return;

                link.setAttribute('data-export-footnote-ref-index', String(refIndex));
                link.setAttribute('data-export-footnote-target-id', targetId);

                const marker = document.createElement('span');
                marker.className = 'export-footnote-ref-marker';
                marker.setAttribute('data-ref-index', String(refIndex));
                marker.textContent = `${refMarkerPrefix}${refIndex}${refMarkerSuffix}`;
                const markerHost = link.parentElement || link;
                if (markerHost && (!markerHost.style.position || markerHost.style.position === 'static')) {
                    markerHost.style.position = 'relative';
                }
                if (link.parentElement) {
                    markerHost.insertBefore(marker, link);
                } else {
                    link.insertBefore(marker, link.firstChild);
                }

                refs.push({ refIndex, targetId });
                refIndex += 1;
            });

            const orderedDefinitions = Array.from(definitionsById.entries())
                .sort((a, b) => {
                    if (!a[1] || !b[1] || a[1] === b[1]) return 0;
                    const relation = a[1].compareDocumentPosition(b[1]);
                    if (relation & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
                    if (relation & Node.DOCUMENT_POSITION_PRECEDING) return 1;
                    return 0;
                });

            const definitions = orderedDefinitions.map(([id, element]) => ({
                id,
                segments: serializeDefinition(element)
            }));

            const nodesToRemove = new Set();
            orderedDefinitions.forEach(([, element]) => {
                if (!element) return;
                const section = element.closest && element.closest('section.footnotes');
                if (section) {
                    nodesToRemove.add(section);
                } else {
                    nodesToRemove.add(element);
                }
            });

            nodesToRemove.forEach(node => {
                if (!node || !node.parentElement) return;
                if (
                    node.tagName &&
                    node.tagName.toLowerCase() === 'section' &&
                    node.classList &&
                    node.classList.contains('footnotes')
                ) {
                    const prev = node.previousElementSibling;
                    if (prev && prev.tagName && prev.tagName.toLowerCase() === 'hr') {
                        prev.remove();
                    }
                }
                node.remove();
            });

            return {
                refs,
                definitions,
                removedBlocks: nodesToRemove.size
            };
        }, footnoteMarkerPrefix, footnoteMarkerSuffix);

        const footnoteRefs = Array.isArray(footnoteExtraction && footnoteExtraction.refs)
            ? footnoteExtraction.refs
            : [];
        const footnoteDefinitionsById = new Map();
        if (Array.isArray(footnoteExtraction && footnoteExtraction.definitions)) {
            footnoteExtraction.definitions.forEach(def => {
                if (!def || typeof def.id !== 'string') return;
                footnoteDefinitionsById.set(def.id, cloneFootnoteSegments(def.segments));
            });
        }
        const hasFootnotes = footnoteRefs.length > 0 && footnoteDefinitionsById.size > 0;

        const disableCoverToc = false;
        const markerPrefix = '__TOC_MARKER__';
        const markerSuffix = '__END__';
        const tableMarkerPrefix = '__TABLE_ROW_MARKER__';
        const tableMarkerSuffix = '__END__';
        const tocHeadings = await this.page.evaluate((markerPrefix, markerSuffix) => {
            const cleanedText = (text) => String(text || '')
                .replace(/^[\s\u00A0\u200B\u200C\u200D\uFEFF]*\u00B6\s*/, '')
                .trim();

            const headings = Array.from(document.querySelectorAll('h1, h2'))
                .filter(h => h.offsetParent && (h.textContent || '').trim() !== '');

            const coverH1 = headings.find(h => h.tagName.toLowerCase() === 'h1') || null;
            let coverH2 = null;
            if (coverH1) {
                let next = coverH1.nextElementSibling;
                while (next && (next.textContent || '').trim() === '') {
                    next = next.nextElementSibling;
                }
                if (next && next.tagName && next.tagName.toLowerCase() === 'h2') {
                    coverH2 = next;
                }
            } else {
                coverH2 = headings.find(h => h.tagName.toLowerCase() === 'h2') || null;
            }

            let coverStore = document.getElementById('export-cover-store');
            if (!coverStore) {
                coverStore = document.createElement('div');
                coverStore.id = 'export-cover-store';
                coverStore.style.display = 'none';
                coverStore.setAttribute('aria-hidden', 'true');
                document.body.appendChild(coverStore);
            }
            const moveToStore = (el, role) => {
                if (!el) return;
                if (el.parentElement !== coverStore) {
                    el.setAttribute('data-export-cover', role);
                    coverStore.appendChild(el);
                }
            };
            moveToStore(coverH1, 'h1');
            moveToStore(coverH2, 'h2');

            if (!document.getElementById('export-toc-marker-style')) {
                const style = document.createElement('style');
                style.id = 'export-toc-marker-style';
                style.textContent = `
                    .export-toc-marker {
                        position: absolute;
                        left: 0;
                        top: 0;
                        font-size: 2px;
                        line-height: 2px;
                        opacity: 0.02;
                        color: rgba(0, 0, 0, 0.02);
                        pointer-events: none;
                    }
                `;
                document.head.appendChild(style);
            }

            const items = [];
            headings.forEach((h, idx) => {
                let id = h.getAttribute('id');
                if (!id) {
                    id = (h.textContent || '').trim().toLowerCase()
                        .replace(/\s+/g, '-')
                        .replace(/[^\w\-\u0400-\u04FF]/g, '');
                    if (id) h.setAttribute('id', id);
                }
                if (!id) return;

                const tocId = `export-toc-${idx}`;
                if (!document.getElementById(tocId)) {
                    const anchor = document.createElement('span');
                    anchor.className = 'export-toc-anchor';
                    anchor.id = tocId;
                    anchor.style.display = 'block';
                    anchor.style.height = '0';
                    anchor.style.lineHeight = '0';
                    anchor.style.fontSize = '0';
                    anchor.style.pointerEvents = 'none';
                    h.parentElement.insertBefore(anchor, h);
                }

                if (!h.style.position || h.style.position === 'static') {
                    h.style.position = 'relative';
                }

                const token = `${markerPrefix}${idx}${markerSuffix}`;
                if (!h.querySelector('.export-toc-marker')) {
                    const marker = document.createElement('span');
                    marker.className = 'export-toc-marker';
                    marker.textContent = token;
                    h.insertBefore(marker, h.firstChild);
                }

                const text = cleanedText(h.textContent.replace(token, ''));
                items.push({ index: idx, id, tocId, text, level: h.tagName.toLowerCase() });
            });

            return items;
        }, markerPrefix, markerSuffix);

        const contentPdfPath = pdfPath.replace(/\.pdf$/i, '.content.pdf');
        const tocTempPdfPath = pdfPath.replace(/\.pdf$/i, '.toc.tmp.pdf');
        let activeFootnotePlan = { pages: [], refUpdates: [], unresolvedRefs: [] };
        let latestContentFootnoteMarkerPages = new Map();

        const applyFootnoteRefUpdates = async (refUpdates) => {
            if (!Array.isArray(refUpdates) || !refUpdates.length) return;
            await this.page.evaluate((updates) => {
                const byIndex = new Map();
                updates.forEach(update => {
                    if (!update || !Number.isFinite(update.refIndex)) return;
                    byIndex.set(update.refIndex, update);
                });

                let destStore = document.getElementById('export-footnote-dest-store');
                if (!destStore) {
                    destStore = document.createElement('div');
                    destStore.id = 'export-footnote-dest-store';
                    destStore.style.display = 'block';
                    destStore.style.width = '0';
                    destStore.style.height = '0';
                    destStore.style.overflow = 'hidden';
                    destStore.style.position = 'absolute';
                    destStore.style.left = '0';
                    destStore.style.top = '0';
                    destStore.style.pointerEvents = 'none';
                    if (document.body.firstChild) {
                        document.body.insertBefore(destStore, document.body.firstChild);
                    } else {
                        document.body.appendChild(destStore);
                    }
                }
                destStore.innerHTML = '';

                const links = Array.from(document.querySelectorAll('a[data-export-footnote-ref-index]'));
                links.forEach(link => {
                    const refIndex = Number(link.getAttribute('data-export-footnote-ref-index'));
                    if (!Number.isFinite(refIndex)) return;
                    const update = byIndex.get(refIndex);
                    if (!update) return;

                    const linkLabel = String(
                        update.newLabel !== undefined && update.newLabel !== null
                            ? update.newLabel
                            : update.newNumber
                    );
                    link.textContent = linkLabel;
                    link.setAttribute('href', `#${update.destName}`);
                    link.setAttribute('data-export-footnote-number', linkLabel);
                    link.setAttribute('data-export-footnote-dest', String(update.destName));

                    if (update.destName && !document.getElementById(update.destName)) {
                        const destinationAnchor = document.createElement('a');
                        destinationAnchor.id = update.destName;
                        destinationAnchor.setAttribute('name', update.destName);
                        destinationAnchor.style.display = 'block';
                        destinationAnchor.style.width = '0';
                        destinationAnchor.style.height = '0';
                        destinationAnchor.style.overflow = 'hidden';
                        destinationAnchor.style.pointerEvents = 'none';
                        destinationAnchor.style.fontSize = '0';
                        destinationAnchor.textContent = '';
                        destStore.appendChild(destinationAnchor);
                    }
                });
            }, refUpdates);
        };

        const renderContentPdfWithTableBreaks = async () => {
            let tableMarkerIds = [];
            if (!disableTableBreaks) {
                tableMarkerIds = await this.page.evaluate((tableMarkerPrefix, tableMarkerSuffix) => {
                    if (!document.getElementById('export-table-marker-style')) {
                        const style = document.createElement('style');
                        style.id = 'export-table-marker-style';
                        style.textContent = `
                            .export-table-marker {
                                position: absolute;
                                left: 0;
                                top: 0;
                                font-size: 10px;
                                line-height: 10px;
                                opacity: 1;
                                color: #000;
                                pointer-events: none;
                            }
                        `;
                        document.head.appendChild(style);
                    }

                    const ids = [];
                    const tables = Array.from(document.querySelectorAll('table')).filter(t => t.offsetParent);
                    tables.forEach((table, tableIndex) => {
                        table.setAttribute('data-export-table-index', String(tableIndex));
                        const rows = Array.from(table.rows || table.querySelectorAll('tr'));
                        const visibleRows = rows.filter(row => {
                            const rect = row.getBoundingClientRect();
                            return rect && rect.height > 0;
                        });
                        const first = visibleRows[0] || null;
                        const second = visibleRows[1] || null;

                        [first, second].forEach((row, rowIndex) => {
                            if (!row) return;
                            const cell = row.querySelector('th, td') || row;
                            if (!cell) return;
                            if (!cell.style.position || cell.style.position === 'static') {
                                cell.style.position = 'relative';
                            }
                            const markerId = tableIndex * 10 + rowIndex;
                            if (cell.querySelector(`.export-table-marker[data-marker-id="${markerId}"]`)) {
                                return;
                            }
                            const marker = document.createElement('span');
                            marker.className = 'export-table-marker';
                            marker.setAttribute('data-marker-id', String(markerId));
                            marker.textContent = `${tableMarkerPrefix}${markerId}${tableMarkerSuffix}`;
                            cell.insertBefore(marker, cell.firstChild);
                            ids.push(markerId);
                        });
                    });

                    return ids;
                }, tableMarkerPrefix, tableMarkerSuffix);
            }

            await this.page.pdf({ path: contentPdfPath, ...pdfOptionsNoHeader });

            if (!disableTableBreaks && tableMarkerIds.length) {
                const { markerPages: tableMarkerPages } = await extractMarkerPagesFromPdf(contentPdfPath, tableMarkerPrefix, tableMarkerSuffix);
                const tablePages = new Map();
                tableMarkerIds.forEach(id => {
                    const page = tableMarkerPages.get(id);
                    if (!page) return;
                    const tableIndex = Math.floor(id / 10);
                    const rowIndex = id % 10;
                    const entry = tablePages.get(tableIndex) || { first: null, second: null };
                    if (rowIndex === 0) entry.first = page;
                    if (rowIndex === 1) entry.second = page;
                    tablePages.set(tableIndex, entry);
                });

                const tablesToBreak = [];
                tablePages.forEach((entry, tableIndex) => {
                    if (entry.first && entry.second && entry.second > entry.first) {
                        tablesToBreak.push(tableIndex);
                    }
                });

                if (tablesToBreak.length) {
                    await this.page.evaluate((tableIndices) => {
                        const tables = Array.from(document.querySelectorAll('table')).filter(t => t.offsetParent);
                        const byIndex = new Map();
                        tables.forEach((table, idx) => {
                            const attr = table.getAttribute('data-export-table-index');
                            const key = attr !== null ? Number(attr) : idx;
                            if (!Number.isNaN(key)) byIndex.set(key, table);
                        });

                        const findPrevHeading = (table) => {
                            let prev = table.previousElementSibling;
                            while (prev && prev.textContent.trim() === '' && !prev.querySelector('img,table,video,pre,code')) {
                                prev = prev.previousElementSibling;
                            }
                            if (prev && /^H[1-6]$/.test(prev.tagName)) return prev;
                            return null;
                        };
                        const ensureBreakBefore = (target) => {
                            if (!target || !target.parentElement) return;
                            const prev = target.previousElementSibling;
                            if (prev && prev.classList && prev.classList.contains('export-forced-break')) return;
                            const breaker = document.createElement('div');
                            breaker.className = 'export-forced-break';
                            breaker.style.display = 'block';
                            breaker.style.width = '100%';
                            breaker.style.height = '0';
                            breaker.style.margin = '0';
                            breaker.style.padding = '0';
                            breaker.style.border = '0';
                            breaker.style.pointerEvents = 'none';
                            breaker.style.breakAfter = 'page';
                            breaker.style.pageBreakAfter = 'always';
                            target.parentElement.insertBefore(breaker, target);
                        };

                        tableIndices.forEach(index => {
                            const table = byIndex.get(index);
                            if (!table) return;
                            const target = findPrevHeading(table) || table;
                            target.style.breakBefore = '';
                            target.style.pageBreakBefore = '';
                            table.style.breakBefore = '';
                            table.style.pageBreakBefore = '';
                            target.removeAttribute('data-forced-page-break');
                            table.removeAttribute('data-forced-page-break');
                            target.style.breakBefore = 'page';
                            target.style.pageBreakBefore = 'always';
                            ensureBreakBefore(target);
                            target.setAttribute('data-forced-page-break', 'before');
                            table.setAttribute('data-forced-page-break', 'before');
                        });
                    }, tablesToBreak);
                }

                await this.page.evaluate(() => {
                    document.querySelectorAll('.export-table-marker').forEach(node => node.remove());
                    const style = document.getElementById('export-table-marker-style');
                    if (style) style.remove();
                });

                if (tablesToBreak.length) {
                    await this.page.pdf({ path: contentPdfPath, ...pdfOptionsNoHeader });
                }
            } else if (!disableTableBreaks) {
                await this.page.evaluate(() => {
                    document.querySelectorAll('.export-table-marker').forEach(node => node.remove());
                    const style = document.getElementById('export-table-marker-style');
                    if (style) style.remove();
                });
            }
        };

        await renderContentPdfWithTableBreaks();

        if (hasFootnotes) {
            const computeFootnotePlan = async () => {
                const { markerPages: footnoteRefPages } = await extractMarkerPagesFromPdf(
                    contentPdfPath,
                    footnoteMarkerPrefix,
                    footnoteMarkerSuffix
                );
                latestContentFootnoteMarkerPages = footnoteRefPages;
                return buildFootnotePagePlan(footnoteRefs, footnoteRefPages, footnoteDefinitionsById);
            };

            activeFootnotePlan = await computeFootnotePlan();
            await applyFootnoteRefUpdates(activeFootnotePlan.refUpdates);

            await renderContentPdfWithTableBreaks();
            activeFootnotePlan = await computeFootnotePlan();
            await applyFootnoteRefUpdates(activeFootnotePlan.refUpdates);

            await renderContentPdfWithTableBreaks();
            activeFootnotePlan = await computeFootnotePlan();
            await applyFootnoteRefUpdates(activeFootnotePlan.refUpdates);

            let estimated = await estimateFootnoteAreaMmInBrowser(this.page, activeFootnotePlan.pages, {
                leftMarginMm: 10,
                rightMarginMm: 10,
                fontSizePt: footnoteFontSizePt,
                lineHeightMultiplier: footnoteLineHeightMultiplier,
                itemGapMm: ptToMm(footnoteItemGapPt),
                topPaddingMm: ptToMm(footnoteTopPaddingPt),
                bottomPaddingMm: ptToMm(footnoteBottomPaddingPt)
            });

            if (estimated.maxRequiredMm > footnoteAreaMm + 0.25) {
                footnoteAreaMm = Math.ceil(estimated.maxRequiredMm + 1);
                const expandedMargin = applyPdfMarginState();
                await setDynamicPageMargins(expandedMargin.bottomMarginCss);
                console.log(`Footnote footer expanded to ${footnoteAreaMm}mm due to overflow.`);

                await renderContentPdfWithTableBreaks();
                activeFootnotePlan = await computeFootnotePlan();
                await applyFootnoteRefUpdates(activeFootnotePlan.refUpdates);

                await renderContentPdfWithTableBreaks();
                activeFootnotePlan = await computeFootnotePlan();
                await applyFootnoteRefUpdates(activeFootnotePlan.refUpdates);

                await renderContentPdfWithTableBreaks();
                activeFootnotePlan = await computeFootnotePlan();
                await applyFootnoteRefUpdates(activeFootnotePlan.refUpdates);

                estimated = await estimateFootnoteAreaMmInBrowser(this.page, activeFootnotePlan.pages, {
                    leftMarginMm: 10,
                    rightMarginMm: 10,
                    fontSizePt: footnoteFontSizePt,
                    lineHeightMultiplier: footnoteLineHeightMultiplier,
                    itemGapMm: ptToMm(footnoteItemGapPt),
                    topPaddingMm: ptToMm(footnoteTopPaddingPt),
                    bottomPaddingMm: ptToMm(footnoteBottomPaddingPt)
                });
            }
        }

        const { markerPages } = await extractMarkerPagesFromPdf(contentPdfPath, markerPrefix, markerSuffix);

        const tocItems = tocHeadings.map(item => ({
            index: item.index,
            id: item.id,
            tocId: item.tocId,
            text: item.text,
            level: item.level,
            page: markerPages.get(item.index) || null
        }));

        const renderToc = async (items, pageOffset, showNumbers, hideContent) => {
            await this.page.evaluate((tocItems, pageOffset, showNumbers, hideContent) => {
                const cleanedText = (text) => String(text || '')
                    .replace(/__TOC_MARKER__\d+__END__/g, '')
                    .replace(/^[\s\u00A0\u200B\u200C\u200D\uFEFF]*\u00B6\s*/, '')
                    .trim();

                const mainContentSelectors = [
                    'main',
                    '.main-content',
                    '.content',
                    '.article-content',
                    '.page-content',
                    '.wiki-content',
                    '.post-content',
                    '[role="main"]',
                    '.page-body',
                    '.article-body'
                ];

                let container = null;
                for (const selector of mainContentSelectors) {
                    const el = document.querySelector(selector);
                    if (el) { container = el; break; }
                }
                if (!container) container = document.body;

                const headings = Array.from(document.querySelectorAll('h1, h2'))
                    .filter(h => h.offsetParent && (h.textContent || '').trim() !== '');
                if (!headings.length) return;

            const coverStore = document.getElementById('export-cover-store');
            const storedH1 = coverStore ? coverStore.querySelector('[data-export-cover="h1"]') : null;
            const storedH2 = coverStore ? coverStore.querySelector('[data-export-cover="h2"]') : null;

            const coverH1 = storedH1 || headings.find(h => h.tagName.toLowerCase() === 'h1') || null;
            let coverH2 = null;
            if (storedH1) {
                coverH2 = storedH2 || null;
            } else if (coverH1) {
                let next = coverH1.nextElementSibling;
                while (next && (next.textContent || '').trim() === '') {
                    next = next.nextElementSibling;
                }
                if (next && next.tagName && next.tagName.toLowerCase() === 'h2') {
                    coverH2 = next;
                }
            } else {
                coverH2 = headings.find(h => h.tagName.toLowerCase() === 'h2') || null;
            }

                const visibleH1 = headings.find(h => h.tagName.toLowerCase() === 'h1') || null;
                const h1StyleSource = visibleH1 || coverH1 || headings[0] || null;
                let h1Color = '';
                if (h1StyleSource) {
                    const isTransparent = (value) => {
                        if (!value) return true;
                        const v = value.replace(/\s+/g, '').toLowerCase();
                        return v === 'transparent' || v === 'rgba(0,0,0,0)';
                    };
                    const parseBgColor = (value) => {
                        if (!value || value === 'none') return '';
                        const rgb = value.match(/rgba?\([^)]+\)/i);
                        if (rgb && !isTransparent(rgb[0])) return rgb[0];
                        const hex = value.match(/#([0-9a-f]{3,8})/i);
                        return hex ? hex[0] : '';
                    };
                    const pickColor = (value) => (isTransparent(value) ? '' : value);
                    const colors = [];
                    const cs = window.getComputedStyle(h1StyleSource);
                    const after = window.getComputedStyle(h1StyleSource, '::after');
                    const before = window.getComputedStyle(h1StyleSource, '::before');
                    colors.push(pickColor(after.borderBottomColor));
                    colors.push(pickColor(after.backgroundColor));
                    colors.push(parseBgColor(after.backgroundImage));
                    colors.push(pickColor(before.borderBottomColor));
                    colors.push(pickColor(before.backgroundColor));
                    colors.push(parseBgColor(before.backgroundImage));
                    const hasLine = cs.borderBottomStyle !== 'none' && cs.borderBottomWidth !== '0px';
                    colors.push(hasLine ? pickColor(cs.borderBottomColor) : '');
                    colors.push(parseBgColor(cs.backgroundImage));

                    let sibling = h1StyleSource.nextElementSibling;
                    let steps = 0;
                    while (sibling && steps < 3) {
                        const scs = window.getComputedStyle(sibling);
                        const hasBorder = scs.borderTopStyle !== 'none' || scs.borderBottomStyle !== 'none';
                        const borderColor = pickColor(scs.borderTopColor) || pickColor(scs.borderBottomColor);
                        if (hasBorder && borderColor) {
                            colors.push(borderColor);
                            break;
                        }
                        if (sibling.tagName && sibling.tagName.toLowerCase() === 'hr') {
                            const hrColor = pickColor(scs.borderTopColor) || pickColor(scs.borderBottomColor);
                            if (hrColor) {
                                colors.push(hrColor);
                                break;
                            }
                        }
                        sibling = sibling.nextElementSibling;
                        steps += 1;
                    }

                    colors.push(pickColor(cs.color));

                    const nonEmpty = colors.filter(Boolean);
                    const nonBlack = nonEmpty.find(c => {
                        const v = c.replace(/\s+/g, '').toLowerCase();
                        return v !== 'rgb(0,0,0)' && v !== '#000' && v !== '#000000';
                    });
                    h1Color = nonBlack || nonEmpty[0] || '';
                }

                let cover = document.getElementById('export-cover');
                if (!cover) {
                    cover = document.createElement('div');
                    cover.id = 'export-cover';
                    cover.className = 'export-cover';
                }
                cover.innerHTML = '';

                const cleanHeadingClone = (node) => {
                    if (!node) return;
                    node.querySelectorAll('.export-toc-marker, .toc-anchor').forEach(el => el.remove());
                    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
                    while (walker.nextNode()) {
                        const textNode = walker.currentNode;
                        if (textNode && textNode.nodeValue) {
                            textNode.nodeValue = textNode.nodeValue
                                .replace(/__TOC_MARKER__\d+__END__/g, '')
                                .replace(/\u00B6/g, '');
                        }
                    }
                };

                if (coverH1) {
                    const clone = coverH1.cloneNode(true);
                    cleanHeadingClone(clone);
                    if (h1Color) {
                        clone.style.setProperty('color', h1Color, 'important');
                    }
                    cover.appendChild(clone);
                }
                if (coverH2 && coverH2 !== coverH1) {
                    const clone = coverH2.cloneNode(true);
                    cleanHeadingClone(clone);
                    cover.appendChild(clone);
                }

                let toc = document.getElementById('export-toc');
                if (!toc) {
                    toc = document.createElement('div');
                    toc.id = 'export-toc';
                    toc.className = 'export-toc';
                }
                toc.innerHTML = '';

                const parseColor = (value) => {
                    if (!value) return null;
                    const v = value.trim().toLowerCase();
                    if (v === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
                    const rgb = v.match(/^rgba?\(([^)]+)\)$/);
                    if (rgb) {
                        const parts = rgb[1].split(',').map(s => parseFloat(s.trim()));
                        if (parts.length >= 3) {
                            return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1 };
                        }
                    }
                    const hex = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
                    if (hex) {
                        const h = hex[1];
                        const toByte = (s) => parseInt(s, 16);
                        if (h.length === 3) {
                            return {
                                r: toByte(h[0] + h[0]),
                                g: toByte(h[1] + h[1]),
                                b: toByte(h[2] + h[2]),
                                a: 1
                            };
                        }
                        return {
                            r: toByte(h.slice(0, 2)),
                            g: toByte(h.slice(2, 4)),
                            b: toByte(h.slice(4, 6)),
                            a: 1
                        };
                    }
                    return null;
                };

                const linkCandidate = Array.from(document.querySelectorAll('a[href]'))
                    .find(a => !a.closest('#export-toc') && !a.closest('#export-cover'));
                let linkColor = '#0066cc';
                if (linkCandidate) {
                    const candidateColor = window.getComputedStyle(linkCandidate).color;
                    const parsed = parseColor(candidateColor);
                    if (parsed && (parsed.a ?? 1) > 0.2) {
                        const luminance = (0.2126 * parsed.r + 0.7152 * parsed.g + 0.0722 * parsed.b) / 255;
                        if (luminance < 0.92) {
                            linkColor = candidateColor;
                        }
                    }
                }

                const list = document.createElement('ul');
                list.className = 'export-toc-list';

                const skipIds = new Set([coverH1 && coverH1.id, coverH2 && coverH2.id].filter(Boolean));
                tocItems
                    .filter(item => !skipIds.has(item.id))
                    .forEach(item => {
                        const li = document.createElement('li');
                        li.className = `export-toc-item ${item.level}`;

                        const link = document.createElement('a');
                        link.className = 'export-toc-link';
                        const targetId = item.tocId || item.id;
                        link.setAttribute('href', `#${targetId}`);
                        link.style.setProperty('color', linkColor, 'important');
                        link.appendChild(document.createTextNode(cleanedText(item.text)));
                        if (item.level === 'h1' && h1Color) {
                            link.style.setProperty('color', linkColor, 'important');
                        }

                        const dots = document.createElement('span');
                        dots.className = 'export-toc-dots';

                        const pageSpan = document.createElement('span');
                        pageSpan.className = 'export-toc-page';
                        if (showNumbers && item.page !== null && item.page !== undefined) {
                            pageSpan.textContent = String(item.page + pageOffset);
                        } else {
                            pageSpan.textContent = '';
                        }

                        link.appendChild(dots);
                        link.appendChild(pageSpan);
                        li.appendChild(link);
                        list.appendChild(li);
                    });

                toc.appendChild(list);

                const parent = container !== document.body ? container.parentElement : document.body;
                if (!cover.parentElement) {
                    if (container !== document.body) {
                        container.parentElement.insertBefore(toc, container);
                        container.parentElement.insertBefore(cover, toc);
                    } else {
                        document.body.insertBefore(toc, document.body.firstChild);
                        document.body.insertBefore(cover, toc);
                    }
                }

                if (h1Color) {
                    toc.style.setProperty('--export-h1-color', h1Color);
                }
                if (linkColor) {
                    toc.style.setProperty('--export-link-color', linkColor);
                }
                cover.setAttribute('data-forced-page-break', 'after');
                toc.setAttribute('data-forced-page-break', 'after');

                const markHidden = (el) => {
                    if (el.getAttribute('data-export-hidden') === '1') return;
                    el.setAttribute('data-export-hidden', '1');
                    el.setAttribute('data-export-display', el.style.display || '');
                    el.style.display = 'none';
                };

                const restoreHidden = (el) => {
                    if (el.getAttribute('data-export-hidden') !== '1') return;
                    const prev = el.getAttribute('data-export-display');
                    if (prev) {
                        el.style.display = prev;
                    } else {
                        el.style.removeProperty('display');
                    }
                    el.removeAttribute('data-export-hidden');
                    el.removeAttribute('data-export-display');
                };

                Array.from(parent.children).forEach(child => {
                    if (child.id === 'export-cover' || child.id === 'export-toc' || child.id === 'export-cover-store') return;
                    if (hideContent) {
                        markHidden(child);
                    } else {
                        restoreHidden(child);
                    }
                });

                const garbage = /^[\s\uFFFD\?\u00B6]+$/;
                const walker = document.createTreeWalker(parent, NodeFilter.SHOW_TEXT);
                const toRemove = [];
                while (walker.nextNode()) {
                    const node = walker.currentNode;
                    if (node && garbage.test(node.nodeValue || '')) {
                        toRemove.push(node);
                    }
                }
                toRemove.forEach(node => node.remove());
            }, items, pageOffset, showNumbers, hideContent);
        };

        await renderToc(tocItems, 0, false, true);
        await this.page.pdf({ path: tocTempPdfPath, ...pdfOptionsNoHeader });

        const tocPageCount = await getPdfPageCount(tocTempPdfPath);

        await renderToc(tocItems, tocPageCount, true, false);

        const probePdfPath = pdfPath.replace(/\.pdf$/i, '.probe.pdf');
        await this.page.pdf({ path: probePdfPath, ...pdfOptionsNoHeader });

        const { markerPages: probeMarkerPages } = await extractMarkerPagesFromPdf(probePdfPath, markerPrefix, markerSuffix);
        const offsetCounts = new Map();
        tocItems.forEach(item => {
            const contentPage = markerPages.get(item.index);
            const probePage = probeMarkerPages.get(item.index);
            if (!contentPage || !probePage) return;
            const delta = probePage - contentPage;
            offsetCounts.set(delta, (offsetCounts.get(delta) || 0) + 1);
        });
        let computedOffset = tocPageCount;
        let topCount = 0;
        offsetCounts.forEach((count, delta) => {
            if (count > topCount) {
                topCount = count;
                computedOffset = delta;
            }
        });

        if (computedOffset !== tocPageCount) {
            await renderToc(tocItems, computedOffset, true, false);
        }

        await this.page.evaluate(() => {
            document.querySelectorAll('.export-toc-marker').forEach(node => node.remove());
            const style = document.getElementById('export-toc-marker-style');
            if (style) style.remove();
        });

        let finalFootnotePlans = [];
        if (hasFootnotes) {
            const { markerPages: probeFootnoteMarkerPages } = await extractMarkerPagesFromPdf(
                probePdfPath,
                footnoteMarkerPrefix,
                footnoteMarkerSuffix
            );

            const footnoteOffsetCounts = new Map();
            footnoteRefs.forEach(ref => {
                if (!ref || !Number.isFinite(ref.refIndex)) return;
                const contentPage = latestContentFootnoteMarkerPages.get(ref.refIndex);
                const probePage = probeFootnoteMarkerPages.get(ref.refIndex);
                if (!contentPage || !probePage) return;
                const delta = probePage - contentPage;
                footnoteOffsetCounts.set(delta, (footnoteOffsetCounts.get(delta) || 0) + 1);
            });

            let computedFootnoteOffset = computedOffset;
            let footnoteTopCount = 0;
            footnoteOffsetCounts.forEach((count, delta) => {
                if (count > footnoteTopCount) {
                    footnoteTopCount = count;
                    computedFootnoteOffset = delta;
                }
            });

            finalFootnotePlans = shiftFootnotePlansByOffset(activeFootnotePlan.pages, computedFootnoteOffset);
        }

        await this.page.evaluate(() => {
            document.querySelectorAll('.export-footnote-ref-marker').forEach(node => node.remove());
            const footnoteMarkerStyle = document.getElementById('export-footnote-marker-style');
            if (footnoteMarkerStyle) footnoteMarkerStyle.remove();
        });

        await this.page.pdf({ path: pdfPath, ...pdfOptionsFinal });

        if (finalFootnotePlans.length > 0) {
            await injectFootnotesOverlayIntoPdf(this.browser, pdfPath, finalFootnotePlans, {
                leftMarginMm: 10,
                rightMarginMm: 10,
                pageNumberBandMm,
                footnoteAreaMm,
                fontSizePt: footnoteFontSizePt,
                lineHeightMultiplier: footnoteLineHeightMultiplier,
                itemGapMm: ptToMm(footnoteItemGapPt),
                topPaddingMm: ptToMm(footnoteTopPaddingPt),
                bottomPaddingMm: ptToMm(footnoteBottomPaddingPt)
            });
        }

        console.log('PDF file has been saved as:', pdfPath);
        return pdfPath;
    }

    async cleanupTempFiles(pdfPath) {
        console.log('Cleaning up temporary files...');
        
        try {
            const filesToRemove = [
                'index.html',
                'styles/inline_styles.css'
            ];
            
            // Remove individual files
            filesToRemove.forEach(file => {
                const filePath = path.join(this.config.outputDir, file);
                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                    console.log(`Removed: ${file}`);
                }
            });

            const tempPdfPaths = [
                pdfPath.replace(/\.pdf$/i, '.content.pdf'),
                pdfPath.replace(/\.pdf$/i, '.toc.pdf'),
                pdfPath.replace(/\.pdf$/i, '.toc.tmp.pdf'),
                pdfPath.replace(/\.pdf$/i, '.probe.pdf')
            ];

            tempPdfPaths.forEach(filePath => {
                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                    console.log(`Removed: ${path.basename(filePath)}`);
                }
            });
            
            // Remove directories and their contents
            const dirsToRemove = ['fonts', 'images', 'styles'];
            dirsToRemove.forEach(dir => {
                const dirPath = path.join(this.config.outputDir, dir);
                if (fs.existsSync(dirPath)) {
                    // Remove all files in directory
                    const files = fs.readdirSync(dirPath);
                    files.forEach(file => {
                        const filePath = path.join(dirPath, file);
                        fs.unlinkSync(filePath);
                        console.log(`Removed: ${dir}/${file}`);
                    });
                    
                    // Remove empty directory
                    fs.rmdirSync(dirPath);
                    console.log(`Removed directory: ${dir}`);
                }
            });
            
            console.log('Temporary files cleanup completed. Only PDF file remains.');
            
        } catch (error) {
            console.error('Error during temporary files cleanup:', error.message);
        }
    }

    async cleanup() {
        if (this.browser) {
            await this.browser.close();
        }
    }
}

// Main execution
(async () => {
    const exporter = new WikiExporter(config);
    try {
        await exporter.init();
        await exporter.export();
    } catch (error) {
        console.error('Export failed:', error);
        process.exit(1);
    }
})();











