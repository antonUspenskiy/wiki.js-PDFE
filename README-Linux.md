# Page to PDF Exporter - Linux Version

This application exports web pages (especially Wiki.js pages) to PDF format with full styling preserved. The PDF files are named using the first H1 header found on the page.

## Linux Installation & Setup

### Prerequisites

1. **Node.js** (version 14 or higher)
   ```bash
   # Ubuntu/Debian
   sudo apt update
   sudo apt install nodejs npm
   
   # CentOS/RHEL
   sudo yum install nodejs npm
   
   # Arch Linux
   sudo pacman -S nodejs npm
   ```

2. **Chrome or Chromium Browser**
   ```bash
   # Ubuntu/Debian - Chromium
   sudo apt install chromium-browser
   
   # Ubuntu/Debian - Google Chrome
   wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | sudo apt-key add -
   echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" | sudo tee /etc/apt/sources.list.d/google-chrome.list
   sudo apt update
   sudo apt install google-chrome-stable
   
   # CentOS/RHEL - Chromium
   sudo yum install chromium
   
   # Arch Linux - Chromium
   sudo pacman -S chromium
   ```

### Quick Setup

#### Option 1: Automatic Setup (Recommended)
1. **Clone or download** this project to your Linux machine
2. **Run the automatic setup script** (installs Node.js and Chrome/Chromium automatically):
   ```bash
   chmod +x setup-auto.sh
   ./setup-auto.sh
   ```
   Or use npm:
   ```bash
   npm run setup-auto
   ```

#### Option 2: Manual Setup
1. **Install prerequisites manually** (see Prerequisites section above)
2. **Run the basic setup script**:
   ```bash
   chmod +x setup.sh
   ./setup.sh
   ```
   Or use npm:
   ```bash
   npm run setup-linux
   ```

3. **Start the application**:
   ```bash
   chmod +x start.sh
   ./start.sh
   ```
   Or use npm:
   ```bash
   npm run start-linux
   ```

## Usage

### GUI Mode (Recommended)
1. Run `./start.sh` or `npm run start-linux`
2. Fill in the form with:
   - **Page URL**: The full URL of the page you want to export
   - **Email**: Your login email
   - **Password**: Your login password
   - **Output Directory**: Where to save the PDF (default: `/home/username/Desktop/test`)
3. Click "Save & Export"

### Command Line Mode
```bash
node Export.js --url "https://your-wiki.com/page" --email "your@email.com" --password "yourpassword" --output "/path/to/output"
```

### Export all pages (API key, cron-friendly)
```bash
node export-all.js --base "https://your-wiki.example.com" --apikey "YOUR_WIKIJS_API_KEY" --output "/srv/wiki-pdf"
```

Optional font overrides:
```bash
node export-all.js --base "https://your-wiki.example.com" --apikey "YOUR_WIKIJS_API_KEY" --output "/srv/wiki-pdf" --font-size 14 --footnote-font-size 8
```

The `export-all.js` command:
- fetches page list from Wiki.js GraphQL API;
- stores PDFs in the same folder hierarchy as wiki paths;
- creates missing PDFs;
- regenerates only outdated PDFs (based on page `updatedAt` vs saved `.meta.json`);
- prints detailed logs to stdout/stderr for cron.

Example crontab (every hour):
```bash
0 * * * * cd /opt/pdfe && /usr/bin/node export-all.js --base https://wiki.example.com --apikey YOUR_TOKEN --output /srv/wiki-pdf >> /var/log/wiki-pdf-export.log 2>&1
```

## Features

- **🚀 Automatic Setup**: Installs Node.js and Chrome/Chromium automatically on Linux
- **🐧 Linux Compatible**: Works on Ubuntu, Debian, CentOS, RHEL, Arch Linux, etc.
- **📄 H1 Header Naming**: PDF files are automatically named using the first H1 header found on the page
- **🎨 Full Styling**: Preserves CSS, fonts, and images in the PDF
- **🔐 Login Support**: Handles authentication for protected pages
- **🧹 Clean Output**: Only saves the PDF file, removes temporary files
- **📦 Smart Detection**: Automatically detects your Linux distribution and uses appropriate package manager

## Troubleshooting

### Chrome/Chromium Not Found
If you get an error about Chrome/Chromium not being found:
1. Install Chrome or Chromium (see Prerequisites above)
2. Make sure it's in one of these locations:
   - `/usr/bin/google-chrome`
   - `/usr/bin/google-chrome-stable`
   - `/usr/bin/chromium-browser`
   - `/usr/bin/chromium`
   - `/snap/bin/chromium`
   - `/opt/google/chrome/chrome`

### Permission Issues
If you get permission errors:
```bash
chmod +x setup.sh start.sh
```

### Node.js Issues
Make sure Node.js is properly installed:
```bash
node --version
npm --version
```

## File Structure

- `Export.js` - Main export logic
- `main.js` - Electron main process
- `index.html` - GUI interface
- `config.json` - Configuration file (auto-generated)
- `setup.sh` - Linux setup script
- `start.sh` - Linux start script
- `package.json` - Node.js dependencies

## Output

The application will:
1. Create a directory structure in your output folder
2. Export the page with all resources
3. Generate a PDF named after the first H1 header
4. Clean up temporary files, leaving only the PDF

Example output filename: `Multichannel_Recording_Tools.pdf`
