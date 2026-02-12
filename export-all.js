const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { spawn } = require('child_process');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

const argv = yargs(hideBin(process.argv))
    .option('config', {
        alias: 'c',
        type: 'string',
        description: 'Path to config file',
        default: './config.json'
    })
    .option('base', {
        alias: 'b',
        type: 'string',
        description: 'Wiki.js base URL'
    })
    .option('apikey', {
        alias: 'k',
        type: 'string',
        description: 'Wiki.js API key'
    })
    .option('output', {
        alias: 'o',
        type: 'string',
        description: 'Output directory for PDFs'
    })
    .option('timeout', {
        alias: 't',
        type: 'number',
        description: 'Request timeout in milliseconds'
    })
    .option('font-size', {
        type: 'number',
        description: 'Override base body font size (px) for PDF rendering'
    })
    .option('footnote-font-size', {
        type: 'number',
        description: 'Footnote font size in pt (default: 8)'
    })
    .option('dry-run', {
        type: 'boolean',
        description: 'Only print sync actions without exporting PDFs',
        default: false
    })
    .help()
    .argv;

function log(level, message) {
    const stamp = new Date().toISOString();
    console.log(`[${stamp}] [${level}] ${message}`);
}

function normalizeBaseUrl(rawBaseUrl) {
    const url = new URL(rawBaseUrl);
    const base = `${url.origin}${url.pathname}`.replace(/\/+$/, '');
    return base || url.origin;
}

function normalizeWikiPath(rawPath) {
    if (typeof rawPath !== 'string') return '/';
    let value = rawPath.trim();
    if (!value) return '/';

    const questionMarkIndex = value.indexOf('?');
    if (questionMarkIndex >= 0) value = value.slice(0, questionMarkIndex);

    const hashIndex = value.indexOf('#');
    if (hashIndex >= 0) value = value.slice(0, hashIndex);

    if (!value.startsWith('/')) value = `/${value}`;
    value = value.replace(/\/{2,}/g, '/');
    if (value.length > 1 && value.endsWith('/')) value = value.slice(0, -1);
    return value || '/';
}

function sanitizePathSegment(segment) {
    let safe = String(segment || '').trim();
    if (!safe || safe === '.' || safe === '..') safe = '_';
    safe = safe.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/\s+/g, ' ').trim();
    if (!safe || safe === '.' || safe === '..') safe = '_';
    return safe;
}

function buildRelativePdfPath(pagePath) {
    const normalizedPath = normalizeWikiPath(pagePath);
    const segments = normalizedPath
        .split('/')
        .filter(Boolean)
        .map(sanitizePathSegment)
        .filter(Boolean);

    if (segments.length === 0) {
        return 'home.pdf';
    }

    const fileStem = segments.pop() || 'index';
    const pdfName = `${fileStem}.pdf`;
    return segments.length > 0 ? path.join(...segments, pdfName) : pdfName;
}

function normalizeTimestamp(value) {
    if (!value) return null;
    const millis = Date.parse(value);
    if (Number.isNaN(millis)) return null;
    return new Date(millis).toISOString();
}

function readJsonSafe(filePath) {
    try {
        if (!fs.existsSync(filePath)) return null;
        const raw = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(raw);
    } catch (_) {
        return null;
    }
}

function writeJson(filePath, value) {
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function ensureDirectory(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

function parsePositiveNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function maskApiKey(apiKey) {
    if (!apiKey || apiKey.length < 10) return '***';
    return `${apiKey.slice(0, 6)}...${apiKey.slice(-4)}`;
}

function isPageLike(value) {
    if (!value || typeof value !== 'object') return false;
    const source = (value.node && typeof value.node === 'object') ? value.node : value;
    return typeof source.path === 'string' || typeof source.slug === 'string';
}

function collectPageArrays(node, output) {
    if (Array.isArray(node)) {
        const pageLikeCount = node.filter(isPageLike).length;
        if (pageLikeCount > 0) {
            output.push(node);
        }
        for (const item of node) {
            collectPageArrays(item, output);
        }
        return;
    }

    if (node && typeof node === 'object') {
        for (const value of Object.values(node)) {
            collectPageArrays(value, output);
        }
    }
}

function extractPages(graphqlData) {
    const arrays = [];
    collectPageArrays(graphqlData, arrays);
    if (arrays.length === 0) return [];

    const largestArray = arrays.reduce((best, current) => {
        if (!best || current.length > best.length) return current;
        return best;
    }, null);

    if (!largestArray) return [];

    return largestArray
        .map((item, index) => {
            const source = (item && item.node && typeof item.node === 'object') ? item.node : item;
            const pagePath = typeof source.path === 'string' ? source.path : source.slug;
            if (!pagePath) return null;
            return {
                id: source.id || source.pageId || `idx-${index}`,
                path: normalizeWikiPath(pagePath),
                title: typeof source.title === 'string' ? source.title : '',
                updatedAt: source.updatedAt || source.modifiedAt || source.updated || source.createdAt || null,
                locale: source.locale || null
            };
        })
        .filter(Boolean);
}

function deduplicatePages(pages) {
    const byPath = new Map();
    for (const page of pages) {
        const normalizedPath = normalizeWikiPath(page.path);
        const pageUpdatedIso = normalizeTimestamp(page.updatedAt);
        const existing = byPath.get(normalizedPath);

        if (!existing) {
            byPath.set(normalizedPath, { ...page, path: normalizedPath });
            continue;
        }

        const existingUpdatedIso = normalizeTimestamp(existing.updatedAt);
        if (!existingUpdatedIso && pageUpdatedIso) {
            byPath.set(normalizedPath, { ...page, path: normalizedPath });
            continue;
        }

        if (existingUpdatedIso && pageUpdatedIso) {
            if (Date.parse(pageUpdatedIso) > Date.parse(existingUpdatedIso)) {
                byPath.set(normalizedPath, { ...page, path: normalizedPath });
            }
        }
    }

    return Array.from(byPath.values()).sort((a, b) => a.path.localeCompare(b.path));
}

async function sendGraphqlRequest(endpoint, apiKey, query, variables, timeoutMs) {
    const response = await axios.post(
        endpoint,
        { query, variables },
        {
            timeout: timeoutMs,
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`
            },
            validateStatus: () => true
        }
    );

    if (response.status >= 400) {
        throw new Error(`HTTP ${response.status}`);
    }

    if (!response.data || typeof response.data !== 'object') {
        throw new Error('Invalid GraphQL response payload');
    }

    return response.data;
}

async function fetchWikiPages(baseUrl, apiKey, timeoutMs) {
    const endpoint = `${baseUrl}/graphql`;
    const attempts = [
        {
            name: 'list(limit, offset)',
            query: `
                query ExportAllPages($limit: Int, $offset: Int) {
                    pages {
                        list(limit: $limit, offset: $offset) {
                            id
                            path
                            title
                            updatedAt
                            locale
                        }
                    }
                }
            `,
            variables: { limit: 10000, offset: 0 }
        },
        {
            name: 'list() full',
            query: `
                query ExportAllPages {
                    pages {
                        list {
                            id
                            path
                            title
                            updatedAt
                            locale
                        }
                    }
                }
            `,
            variables: {}
        },
        {
            name: 'list() minimal',
            query: `
                query ExportAllPages {
                    pages {
                        list {
                            id
                            path
                            updatedAt
                        }
                    }
                }
            `,
            variables: {}
        },
        {
            name: 'list() bare',
            query: `
                query ExportAllPages {
                    pages {
                        list {
                            id
                            path
                        }
                    }
                }
            `,
            variables: {}
        }
    ];

    for (const attempt of attempts) {
        log('INFO', `Fetching page list via GraphQL (${attempt.name})...`);

        let payload;
        try {
            payload = await sendGraphqlRequest(endpoint, apiKey, attempt.query, attempt.variables, timeoutMs);
        } catch (error) {
            log('WARN', `GraphQL request failed for "${attempt.name}": ${error.message}`);
            continue;
        }

        if (Array.isArray(payload.errors) && payload.errors.length > 0) {
            const errorText = payload.errors.map(err => err && err.message ? err.message : String(err)).join('; ');
            log('WARN', `GraphQL returned errors for "${attempt.name}": ${errorText}`);
        }

        if (!payload.data || typeof payload.data !== 'object') {
            continue;
        }

        const extracted = extractPages(payload.data);
        const pages = deduplicatePages(extracted);
        if (pages.length > 0) {
            return pages;
        }
    }

    throw new Error('Failed to fetch pages list from Wiki.js GraphQL API.');
}

function buildMetaRecord(page, pageUrl, sourceUpdatedAt, generatedAt) {
    return {
        pageId: page.id || null,
        pagePath: page.path,
        pageTitle: page.title || null,
        pageLocale: page.locale || null,
        pageUrl,
        sourceUpdatedAt: sourceUpdatedAt || null,
        generatedAt: generatedAt || new Date().toISOString()
    };
}

function evaluateSyncState(page, pdfPath, metaPath) {
    const sourceUpdatedAt = normalizeTimestamp(page.updatedAt);

    if (!fs.existsSync(pdfPath)) {
        return {
            shouldExport: true,
            action: 'create',
            reason: 'pdf_missing',
            sourceUpdatedAt
        };
    }

    const meta = readJsonSafe(metaPath);
    if (meta && typeof meta.sourceUpdatedAt === 'string' && sourceUpdatedAt) {
        const metaUpdatedAt = normalizeTimestamp(meta.sourceUpdatedAt);
        if (metaUpdatedAt && metaUpdatedAt === sourceUpdatedAt) {
            return {
                shouldExport: false,
                reason: 'meta_matches_updatedAt',
                sourceUpdatedAt
            };
        }
        return {
            shouldExport: true,
            action: 'update',
            reason: 'meta_mismatch',
            sourceUpdatedAt
        };
    }

    if (sourceUpdatedAt) {
        const stat = fs.statSync(pdfPath);
        if (stat.mtimeMs >= Date.parse(sourceUpdatedAt)) {
            return {
                shouldExport: false,
                reason: 'pdf_mtime_is_fresh',
                sourceUpdatedAt,
                writeMeta: true
            };
        }
        return {
            shouldExport: true,
            action: 'update',
            reason: 'pdf_is_older_than_wiki_page',
            sourceUpdatedAt
        };
    }

    return {
        shouldExport: false,
        reason: 'wiki_page_updatedAt_missing',
        sourceUpdatedAt: null
    };
}

function forwardWithPrefix(stream, prefix, writer) {
    let buffer = '';
    stream.on('data', (chunk) => {
        buffer += chunk.toString();
        let newlineIndex = buffer.indexOf('\n');
        while (newlineIndex !== -1) {
            const line = buffer.slice(0, newlineIndex).trimEnd();
            buffer = buffer.slice(newlineIndex + 1);
            if (line) writer.write(`${prefix}${line}\n`);
            newlineIndex = buffer.indexOf('\n');
        }
    });

    stream.on('end', () => {
        const tail = buffer.trim();
        if (tail) writer.write(`${prefix}${tail}\n`);
    });
}

function runSingleExport(options) {
    return new Promise((resolve) => {
        const args = ['Export.js'];
        if (options.configPath) {
            args.push('--config', options.configPath);
        }
        args.push(
            '--base', options.baseUrl,
            '--article', options.articlePath,
            '--output', options.outputDir,
            '--pdf-name', options.pdfName,
            '--apikey', options.apiKey,
            '--skip-login',
            '--headless',
            '--timeout', String(options.timeout)
        );
        if (Number.isFinite(options.fontSize) && options.fontSize > 0) {
            args.push('--font-size', String(options.fontSize));
        }
        if (Number.isFinite(options.footnoteFontSize) && options.footnoteFontSize > 0) {
            args.push('--footnote-font-size', String(options.footnoteFontSize));
        }

        const child = spawn(process.execPath, args, {
            cwd: __dirname,
            stdio: ['ignore', 'pipe', 'pipe']
        });

        const prefix = `[single:${options.articlePath}] `;
        forwardWithPrefix(child.stdout, prefix, process.stdout);
        forwardWithPrefix(child.stderr, `${prefix}ERR `, process.stderr);

        child.on('error', (error) => {
            resolve({ code: 1, error });
        });

        child.on('close', (code) => {
            resolve({ code: code || 0 });
        });
    });
}

function loadRuntimeConfig() {
    const defaults = {
        baseUrl: '',
        apiKey: '',
        outputDir: './exported',
        timeout: 30000,
        fontSize: null,
        footnoteFontSize: null,
        dryRun: false
    };

    let fileConfig = {};
    let configPath = null;
    if (argv.config && fs.existsSync(argv.config)) {
        configPath = path.resolve(argv.config);
        fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } else if (argv.config && argv.config !== './config.json') {
        throw new Error(`Config file not found: ${argv.config}`);
    }

    const merged = {
        ...defaults,
        ...fileConfig
    };

    if (argv.base) merged.baseUrl = argv.base;
    if (argv.apikey) merged.apiKey = argv.apikey;
    if (argv.output) merged.outputDir = argv.output;
    if (typeof argv.timeout === 'number' && Number.isFinite(argv.timeout) && argv.timeout > 0) {
        merged.timeout = argv.timeout;
    }
    if (typeof argv.fontSize === 'number') merged.fontSize = argv.fontSize;
    if (typeof argv.footnoteFontSize === 'number') merged.footnoteFontSize = argv.footnoteFontSize;
    merged.dryRun = Boolean(argv.dryRun);

    if (!merged.baseUrl) throw new Error('Missing base URL. Use --base or config.baseUrl');
    if (!merged.apiKey) throw new Error('Missing API key. Use --apikey or config.apiKey');
    if (!merged.outputDir) throw new Error('Missing output directory. Use --output or config.outputDir');

    merged.baseUrl = normalizeBaseUrl(merged.baseUrl);
    merged.outputDir = path.resolve(merged.outputDir);
    merged.timeout = Number.isFinite(merged.timeout) && merged.timeout > 0 ? merged.timeout : defaults.timeout;
    merged.fontSize = parsePositiveNumber(merged.fontSize);
    merged.footnoteFontSize = parsePositiveNumber(merged.footnoteFontSize);
    merged.configPath = configPath;

    return merged;
}

async function main() {
    const config = loadRuntimeConfig();
    ensureDirectory(config.outputDir);

    log('INFO', 'Starting export-all sync run.');
    log('INFO', `Base URL: ${config.baseUrl}`);
    log('INFO', `Output directory: ${config.outputDir}`);
    log('INFO', `API key: ${maskApiKey(config.apiKey)}`);
    if (config.dryRun) {
        log('INFO', 'Dry-run mode is enabled. No files will be written.');
    }

    const pages = await fetchWikiPages(config.baseUrl, config.apiKey, config.timeout);
    log('INFO', `Pages discovered: ${pages.length}`);

    const stats = {
        total: pages.length,
        skipped: 0,
        created: 0,
        updated: 0,
        failed: 0
    };

    for (let index = 0; index < pages.length; index++) {
        const page = pages[index];
        const articlePath = normalizeWikiPath(page.path);
        const relativePdfPath = buildRelativePdfPath(articlePath);
        const absolutePdfPath = path.join(config.outputDir, relativePdfPath);
        const pageOutputDir = path.dirname(absolutePdfPath);
        const pdfName = path.basename(absolutePdfPath);
        const metaPath = `${absolutePdfPath}.meta.json`;
        const pageUrl = `${config.baseUrl}${articlePath}`;
        const itemLabel = `${index + 1}/${pages.length} ${articlePath}`;

        const syncState = evaluateSyncState(page, absolutePdfPath, metaPath);
        if (!syncState.shouldExport) {
            stats.skipped += 1;
            log('SKIP', `${itemLabel} (${syncState.reason})`);

            if (!config.dryRun && syncState.writeMeta) {
                const stat = fs.statSync(absolutePdfPath);
                const generatedAt = new Date(stat.mtimeMs).toISOString();
                const metaRecord = buildMetaRecord(page, pageUrl, syncState.sourceUpdatedAt, generatedAt);
                writeJson(metaPath, metaRecord);
                log('INFO', `${itemLabel} metadata refreshed.`);
            }
            continue;
        }

        const actionLabel = syncState.action === 'create' ? 'CREATE' : 'UPDATE';
        log(actionLabel, `${itemLabel} -> ${relativePdfPath} (${syncState.reason})`);

        if (config.dryRun) {
            if (syncState.action === 'create') stats.created += 1;
            if (syncState.action === 'update') stats.updated += 1;
            continue;
        }

        ensureDirectory(pageOutputDir);
        const startedAt = Date.now();
        const result = await runSingleExport({
            configPath: config.configPath,
            baseUrl: config.baseUrl,
            articlePath,
            outputDir: pageOutputDir,
            pdfName,
            apiKey: config.apiKey,
            timeout: config.timeout,
            fontSize: config.fontSize,
            footnoteFontSize: config.footnoteFontSize
        });

        if (result.code !== 0) {
            stats.failed += 1;
            log('ERROR', `${itemLabel} export failed with exit code ${result.code}`);
            continue;
        }

        if (!fs.existsSync(absolutePdfPath)) {
            stats.failed += 1;
            log('ERROR', `${itemLabel} exported but expected PDF not found at ${absolutePdfPath}`);
            continue;
        }

        const metaRecord = buildMetaRecord(page, pageUrl, syncState.sourceUpdatedAt, new Date().toISOString());
        writeJson(metaPath, metaRecord);

        if (syncState.action === 'create') stats.created += 1;
        if (syncState.action === 'update') stats.updated += 1;

        const elapsedMs = Date.now() - startedAt;
        log('OK', `${itemLabel} completed in ${(elapsedMs / 1000).toFixed(1)}s`);
    }

    log('INFO', `Summary: total=${stats.total}, created=${stats.created}, updated=${stats.updated}, skipped=${stats.skipped}, failed=${stats.failed}`);
    if (stats.failed > 0) {
        process.exitCode = 1;
    }
}

main().catch((error) => {
    log('ERROR', `export-all failed: ${error.message}`);
    process.exit(1);
});
