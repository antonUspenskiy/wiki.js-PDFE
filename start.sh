#!/bin/bash

# Page to PDF Exporter - Linux Start Script
echo "Starting Page to PDF Exporter..."

# Check if dependencies are installed
if [ ! -d "node_modules" ]; then
    echo "Dependencies not found. Running setup first..."
    chmod +x setup.sh
    ./setup.sh
    if [ $? -ne 0 ]; then
        echo "Setup failed. Please check the error messages above."
        exit 1
    fi
fi

# Check if config.json exists
if [ ! -f "config.json" ]; then
    echo "config.json not found. Please run the Electron GUI first to configure the application."
    echo "Starting Electron GUI..."
    npm start
else
    echo "Configuration found. Starting export process..."
    echo "You can also run the GUI with: npm start"
    echo ""
    echo "To export directly from command line, use:"
    echo "node Export.js --url 'https://your-wiki.com/page' --email 'your@email.com' --password 'yourpassword' --output '/path/to/output'"
    echo ""
    echo "Starting GUI..."
    npm start
fi
