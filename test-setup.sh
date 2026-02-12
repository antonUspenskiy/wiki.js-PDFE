#!/bin/bash

# Test script for Page to PDF Exporter setup
echo "🧪 Testing Page to PDF Exporter Setup"
echo "====================================="

# Test Node.js installation
if command -v node &> /dev/null; then
    echo "✅ Node.js: $(node --version)"
else
    echo "❌ Node.js: Not installed"
fi

# Test npm installation
if command -v npm &> /dev/null; then
    echo "✅ npm: $(npm --version)"
else
    echo "❌ npm: Not installed"
fi

# Test browser installation
CHROME_PATHS=(
    "/usr/bin/google-chrome"
    "/usr/bin/google-chrome-stable"
    "/usr/bin/chromium-browser"
    "/usr/bin/chromium"
    "/snap/bin/chromium"
    "/opt/google/chrome/chrome"
    "/usr/local/bin/chrome"
)

BROWSER_FOUND=false
for path in "${CHROME_PATHS[@]}"; do
    if [ -f "$path" ]; then
        echo "✅ Browser: Found at $path"
        BROWSER_FOUND=true
        break
    fi
done

if [ "$BROWSER_FOUND" = false ]; then
    echo "❌ Browser: Not found"
fi

# Test project dependencies
if [ -d "node_modules" ]; then
    echo "✅ Dependencies: Installed"
else
    echo "❌ Dependencies: Not installed"
fi

# Test output directory
OUTPUT_DIR="/home/$USER/Desktop/test"
if [ -d "$OUTPUT_DIR" ]; then
    echo "✅ Output directory: $OUTPUT_DIR exists"
else
    echo "❌ Output directory: $OUTPUT_DIR does not exist"
fi

echo ""
echo "====================================="
if command -v node &> /dev/null && command -v npm &> /dev/null && [ "$BROWSER_FOUND" = true ] && [ -d "node_modules" ]; then
    echo "🎉 All tests passed! Setup is complete."
    echo "You can now run: ./start.sh"
else
    echo "⚠️  Some components are missing. Run ./setup-auto.sh to install them."
fi
