#!/bin/bash

# Page to PDF Exporter - Linux Setup Script
echo "Setting up Page to PDF Exporter for Linux..."

# Function to detect Linux distribution
detect_distro() {
    if [ -f /etc/os-release ]; then
        . /etc/os-release
        echo $ID
    elif [ -f /etc/redhat-release ]; then
        echo "rhel"
    elif [ -f /etc/debian_version ]; then
        echo "debian"
    else
        echo "unknown"
    fi
}

# Function to install Node.js
install_nodejs() {
    local distro=$1
    echo "Installing Node.js..."
    
    case $distro in
        "ubuntu"|"debian")
            # Install Node.js from NodeSource repository for latest LTS
            curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
            sudo apt-get install -y nodejs
            ;;
        "fedora"|"rhel"|"centos")
            # Install Node.js from NodeSource repository
            curl -fsSL https://rpm.nodesource.com/setup_lts.x | sudo bash -
            sudo yum install -y nodejs
            ;;
        "arch"|"manjaro")
            sudo pacman -S --noconfirm nodejs npm
            ;;
        "opensuse"|"sles")
            sudo zypper install -y nodejs npm
            ;;
        *)
            echo "Unsupported distribution: $distro"
            echo "Please install Node.js manually from: https://nodejs.org/"
            return 1
            ;;
    esac
}

# Function to install Chrome/Chromium
install_browser() {
    local distro=$1
    echo "Installing Chrome/Chromium browser..."
    
    case $distro in
        "ubuntu"|"debian")
            # Try to install Chromium first (easier)
            if sudo apt-get install -y chromium-browser; then
                echo "Chromium installed successfully"
                return 0
            fi
            
            # If Chromium fails, try Google Chrome
            echo "Installing Google Chrome..."
            wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | sudo apt-key add -
            echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" | sudo tee /etc/apt/sources.list.d/google-chrome.list
            sudo apt-get update
            sudo apt-get install -y google-chrome-stable
            ;;
        "fedora"|"rhel"|"centos")
            # Install Chromium
            sudo yum install -y chromium
            ;;
        "arch"|"manjaro")
            sudo pacman -S --noconfirm chromium
            ;;
        "opensuse"|"sles")
            sudo zypper install -y chromium
            ;;
        *)
            echo "Unsupported distribution: $distro"
            echo "Please install Chrome or Chromium manually"
            return 1
            ;;
    esac
}

# Detect Linux distribution
DISTRO=$(detect_distro)
echo "Detected Linux distribution: $DISTRO"

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "Node.js is not installed. Attempting to install automatically..."
    if install_nodejs $DISTRO; then
        echo "Node.js installed successfully"
    else
        echo "Failed to install Node.js automatically. Please install manually."
        exit 1
    fi
else
    echo "Node.js is already installed: $(node --version)"
fi

# Check if npm is installed
if ! command -v npm &> /dev/null; then
    echo "npm is not installed. Attempting to install automatically..."
    if install_nodejs $DISTRO; then
        echo "npm installed successfully"
    else
        echo "Failed to install npm automatically. Please install manually."
        exit 1
    fi
else
    echo "npm is already installed: $(npm --version)"
fi

# Install dependencies
echo "Installing dependencies..."
npm install

# Check for Chrome/Chromium
echo "Checking for Chrome/Chromium browser..."
CHROME_FOUND=false

# Check common Chrome/Chromium paths
CHROME_PATHS=(
    "/usr/bin/google-chrome"
    "/usr/bin/google-chrome-stable"
    "/usr/bin/chromium-browser"
    "/usr/bin/chromium"
    "/snap/bin/chromium"
    "/opt/google/chrome/chrome"
    "/usr/local/bin/chrome"
)

for path in "${CHROME_PATHS[@]}"; do
    if [ -f "$path" ]; then
        echo "Found browser at: $path"
        CHROME_FOUND=true
        break
    fi
done

if [ "$CHROME_FOUND" = false ]; then
    echo "Chrome/Chromium not found. Attempting to install automatically..."
    if install_browser $DISTRO; then
        echo "Browser installed successfully"
        CHROME_FOUND=true
    else
        echo "Failed to install browser automatically."
        echo "Please install one of the following manually:"
        echo "  - Google Chrome: https://www.google.com/chrome/"
        echo "  - Chromium: sudo apt install chromium-browser (Ubuntu/Debian)"
        echo "  - Chromium: sudo yum install chromium (CentOS/RHEL)"
        echo "  - Chromium: sudo pacman -S chromium (Arch Linux)"
        exit 1
    fi
fi

# Create output directory if it doesn't exist
OUTPUT_DIR="/home/$USER/Desktop/test"
if [ ! -d "$OUTPUT_DIR" ]; then
    echo "Creating output directory: $OUTPUT_DIR"
    mkdir -p "$OUTPUT_DIR"
fi

# Check if user has sudo access
if ! sudo -n true 2>/dev/null; then
    echo ""
    echo "⚠️  Note: This script requires sudo access to install Node.js and Chrome/Chromium."
    echo "   If you don't have sudo access, you'll need to install these manually:"
    echo "   - Node.js: https://nodejs.org/"
    echo "   - Chrome/Chromium: https://www.google.com/chrome/ or your package manager"
    echo ""
fi

echo ""
echo "✅ Setup completed successfully!"
echo ""
echo "📋 Summary:"
echo "   - Linux distribution: $DISTRO"
echo "   - Node.js: $(node --version 2>/dev/null || echo 'Not installed')"
echo "   - npm: $(npm --version 2>/dev/null || echo 'Not installed')"
echo "   - Browser: $([ "$CHROME_FOUND" = true ] && echo 'Found' || echo 'Not found')"
echo "   - Output directory: $OUTPUT_DIR"
echo ""
echo "🚀 You can now run the application with:"
echo "   ./start.sh"
echo "   or"
echo "   npm run start-linux"
