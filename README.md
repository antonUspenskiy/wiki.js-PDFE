# Wiki.js Page Exporter

This tool allows you to export Wiki.js pages to PDF files. You can export a single page (legacy, via browser automation) or export the entire site using a Wiki.js API key.

## Installation

1. Make sure you have Node.js installed on your system
2. Clone or download this repository
3. Install dependencies:
```bash
npm install
```

## Configuration

You can configure the tool in two ways:

1. Using a config file (`config.json`):
```json
{
    "baseUrl": "http://your-wiki-url",
    "apiKey": "YOUR_WIKIJS_API_KEY", // required for export-all
    "outputDir": "./exported",       // required for export-all
    "loginPath": "/login",          // used by single-page Export.js
    "articlePath": "/path/to/article",
    "credentials": {                   // used by single-page Export.js
        "email": "your-email@example.com",
        "password": "your-password"
    },
    "timeout": 30000,
    "fontSize": 14,                    // optional, body font size in px
    "footnoteFontSize": 8              // optional, footnote font size in pt
}
```

2. Using command line arguments:
```bash
node Export.js --base https://wiki.example.com --article /path/to/article --email user@example.com --password mypass --output ./output
```

For exporting the entire site via API key:

```bash
npm run export-all -- --config ./config.json
# or provide overrides:
npm run export-all -- --base https://wiki.example.com --apikey YOUR_TOKEN --output ./exported
```

## Available Command Line Options

- `-c, --config`: Path to config file (default: "./config.json")
- `-e, --email`: Email for login
- `-p, --password`: Password for login
- `-a, --article`: Path to the article
- `-o, --output`: Output directory
- `-b, --base`: Base URL
- `-k, --apikey`: Wiki.js API key
- `--skip-login`: Skip login step (used by export-all)
- `--headless`: Run Chromium in headless mode (default: false)
- `--pdf-name`: Force output PDF file name
- `-t, --timeout`: API/export timeout in milliseconds (export-all)
- `--font-size`: Override base body font size in px (Export.js + export-all passthrough)
- `--footnote-font-size`: Override footnote font size in pt (Export.js + export-all passthrough)
- `--dry-run`: Print actions without generating files (export-all)
- `--help`: Show help

Command line arguments will override the corresponding values in the config file.

## Usage

Basic usage with config file:
```bash
npm start
```

Using command line arguments:
```bash
node Export.js --email admin@wiki.com --password secret --article /docs/my-page --output ./exported
```

Export entire site using API key (Linux):
```bash
npm run export-all -- --config ./config.json
```

The exporter fetches all pages via Wiki.js GraphQL API, compares each page's last edit date with the stored PDF's metadata (or file timestamp if metadata is missing), and only regenerates PDFs for pages that changed. A `.meta.json` file is written next to each PDF with the server `updatedAt` value used for future comparisons.

Cron example (every 30 minutes):
```bash
*/30 * * * * cd /opt/pdfe && /usr/bin/node export-all.js --base https://wiki.example.com --apikey YOUR_TOKEN --output /var/wiki-pdf-export >> /var/log/wiki-export.log 2>&1
```

## Output

For single-page export (`Export.js`), a temporary folder is created then cleaned; only the PDF remains.

For export-all (`export-all.js`), PDFs are saved mirroring the wiki path structure. Each PDF has a sibling `.meta.json` storing the page `updatedAt`.

Footnotes are moved from the article body into the PDF footer of the page where each reference appears, renumbered from `1` on every page, and the original footnote blocks are removed from content. Links inside moved footnotes stay clickable in the generated PDF.
