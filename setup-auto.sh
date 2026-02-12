#!/bin/bash

# Page to PDF Exporter - Enhanced Linux Setup Script
# This script automatically installs Node.js and Chrome/Chromium on Linux systems

set -e  # Exit on any error

echo "🚀 Page to PDF Exporter - Linux Setup"
echo "======================================"
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${GREEN}✅ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

print_error() {
    echo -e "${RED}❌ $1${NC}"
}

print_info() {
    echo -e "${BLUE}ℹ️  $1${NC}"
}

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

# Function to check if command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Function to install Node.js
install_nodejs() {
    local distro=$1
    print_info "Installing Node.js for $distro..."
    
    case $distro in
        "ubuntu"|"debian")
            # Update package list first
            sudo apt-get update
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
            print_error "Unsupported distribution: $distro"
            print_info "Please install Node.js manually from: https://nodejs.org/"
            return 1
            ;;
    esac
}

# Function to install Chrome/Chromium
install_browser() {
    local distro=$1
    print_info "Installing browser for $distro..."
    
    case $distro in
        "ubuntu"|"debian")
            # Try to install Chromium first (easier)
            if sudo apt-get install -y chromium-browser; then
                print_status "Chromium installed successfully"
                return 0
            fi
            
            # If Chromium fails, try Google Chrome
            print_info "Installing Google Chrome..."
            wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | sudo apt-key add -
            echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" | sudo tee /etc/apt/sources.list.d/google-chrome.list
            sudo apt-get update
            sudo apt-get install -y google-chrome-stable
            ;;
        "fedora"|"rhel"|"centos")
            sudo yum install -y chromium
            ;;
        "arch"|"manjaro")
            sudo pacman -S --noconfirm chromium
            ;;
        "opensuse"|"sles")
            sudo zypper install -y chromium
            ;;
        *)
            print_error "Unsupported distribution: $distro"
            print_info "Please install Chrome or Chromium manually"
            return 1
            ;;
    esac
}

# Function to check browser installation
check_browser() {
    local CHROME_PATHS=(
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
            echo "$path"
            return 0
        fi
    done
    return 1
}

# Main setup process
main() {
    # Detect Linux distribution
    DISTRO=$(detect_distro)
    print_info "Detected Linux distribution: $DISTRO"
    echo ""
    
    # Check if user has sudo access
    if ! sudo -n true 2>/dev/null; then
        print_warning "This script requires sudo access to install Node.js and Chrome/Chromium."
        print_info "If you don't have sudo access, you'll need to install these manually."
        echo ""
    fi
    
    # Check and install Node.js
    if ! command_exists node; then
        print_info "Node.js not found. Installing automatically..."
        if install_nodejs $DISTRO; then
            print_status "Node.js installed successfully"
        else
            print_error "Failed to install Node.js automatically"
            print_info "Please install manually from: https://nodejs.org/"
            exit 1
        fi
    else
        print_status "Node.js already installed: $(node --version)"
    fi
    
    # Check and install npm
    if ! command_exists npm; then
        print_info "npm not found. Installing automatically..."
        if install_nodejs $DISTRO; then
            print_status "npm installed successfully"
        else
            print_error "Failed to install npm automatically"
            exit 1
        fi
    else
        print_status "npm already installed: $(npm --version)"
    fi
    
    echo ""
    
    # Install project dependencies
    print_info "Installing project dependencies..."
    npm install
    print_status "Dependencies installed"
    echo ""
    
    # Check and install browser
    BROWSER_PATH=$(check_browser)
    if [ -z "$BROWSER_PATH" ]; then
        print_info "Chrome/Chromium not found. Installing automatically..."
        if install_browser $DISTRO; then
            print_status "Browser installed successfully"
        else
            print_error "Failed to install browser automatically"
            print_info "Please install manually:"
            print_info "  - Google Chrome: https://www.google.com/chrome/"
            print_info "  - Chromium: sudo apt install chromium-browser (Ubuntu/Debian)"
            print_info "  - Chromium: sudo yum install chromium (CentOS/RHEL)"
            print_info "  - Chromium: sudo pacman -S chromium (Arch Linux)"
            exit 1
        fi
    else
        print_status "Browser found at: $BROWSER_PATH"
    fi
    
    echo ""
    
    # Create output directory
    OUTPUT_DIR="/home/$USER/Desktop/test"
    if [ ! -d "$OUTPUT_DIR" ]; then
        print_info "Creating output directory: $OUTPUT_DIR"
        mkdir -p "$OUTPUT_DIR"
    fi
    
    # Final summary
    echo "======================================"
    print_status "Setup completed successfully!"
    echo ""
    print_info "📋 Summary:"
    echo "   - Linux distribution: $DISTRO"
    echo "   - Node.js: $(node --version)"
    echo "   - npm: $(npm --version)"
    echo "   - Browser: $(check_browser || echo 'Not found')"
    echo "   - Output directory: $OUTPUT_DIR"
    echo ""
    print_info "🚀 You can now run the application with:"
    echo "   ./start.sh"
    echo "   or"
    echo "   npm run start-linux"
    echo ""
}

# Run main function
main "$@"
