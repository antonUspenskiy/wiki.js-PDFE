const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

let mainWindow;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 800,
        height: 600,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    mainWindow.loadFile('index.html');
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});

// Handle directory selection
ipcMain.handle('select-directory', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory', 'createDirectory']
    });
    if (!result.canceled) {
        return result.filePaths[0];
    }
    return null;
});

// Handle configuration save
ipcMain.on('save-config', (event, config) => {
    let existing = {};
    try {
        if (fs.existsSync('config.json')) {
            existing = JSON.parse(fs.readFileSync('config.json', 'utf8'));
        }
    } catch (_) {
        existing = {};
    }
    const merged = {
        ...existing,
        ...config,
        credentials: {
            ...(existing.credentials || {}),
            ...(config.credentials || {})
        }
    };
    fs.writeFileSync('config.json', JSON.stringify(merged, null, 4));
    event.reply('config-saved');
});

// Handle single-page export start
ipcMain.on('start-export', (event) => {
    const exportProcess = spawn('node', ['Export.js'], {
        stdio: ['pipe', 'pipe', 'pipe']
    });

    exportProcess.stdout.on('data', (data) => {
        event.reply('export-progress', data.toString());
    });

    exportProcess.stderr.on('data', (data) => {
        event.reply('export-error', data.toString());
    });

    exportProcess.on('close', (code) => {
        event.reply('export-complete', code);
    });
});

// Handle export-all (API key) start
ipcMain.on('start-export-all', (event) => {
    const exportAllProcess = spawn('node', ['export-all.js'], {
        stdio: ['pipe', 'pipe', 'pipe']
    });

    exportAllProcess.stdout.on('data', (data) => {
        event.reply('export-all-progress', data.toString());
    });

    exportAllProcess.stderr.on('data', (data) => {
        event.reply('export-all-error', data.toString());
    });

    exportAllProcess.on('close', (code) => {
        event.reply('export-all-complete', code);
    });
});
