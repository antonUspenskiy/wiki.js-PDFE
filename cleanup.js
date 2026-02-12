const fs = require('fs');
const path = require('path');

// Configuration
const SAVED_PAGES_DIR = path.join(__dirname, 'saved_page_complete');
const MAX_AGE_HOURS = 24; // Keep files for 24 hours

function cleanup() {
    console.log('Starting cleanup...');
    
    // Check if directory exists
    if (!fs.existsSync(SAVED_PAGES_DIR)) {
        console.log('No saved pages directory found.');
        return;
    }

    const now = new Date();
    let filesRemoved = 0;
    let totalSizeCleaned = 0;

    // Read all files in the directory
    const files = fs.readdirSync(SAVED_PAGES_DIR);
    
    files.forEach(file => {
        const filePath = path.join(SAVED_PAGES_DIR, file);
        const stats = fs.statSync(filePath);
        
        // Calculate file age in hours
        const fileAge = (now - stats.mtime) / (1000 * 60 * 60);
        
        // Remove files older than MAX_AGE_HOURS
        if (fileAge > MAX_AGE_HOURS) {
            const fileSize = stats.size;
            fs.unlinkSync(filePath);
            filesRemoved++;
            totalSizeCleaned += fileSize;
            console.log(`Removed: ${file} (${(fileSize / 1024).toFixed(2)} KB)`);
        }
    });

    // Clean up empty subdirectories
    const subdirs = fs.readdirSync(SAVED_PAGES_DIR)
        .filter(item => fs.statSync(path.join(SAVED_PAGES_DIR, item)).isDirectory());
    
    subdirs.forEach(dir => {
        const dirPath = path.join(SAVED_PAGES_DIR, dir);
        const dirContents = fs.readdirSync(dirPath);
        
        if (dirContents.length === 0) {
            fs.rmdirSync(dirPath);
            console.log(`Removed empty directory: ${dir}`);
        }
    });

    console.log(`\nCleanup complete!`);
    console.log(`Files removed: ${filesRemoved}`);
    console.log(`Total space cleaned: ${(totalSizeCleaned / 1024).toFixed(2)} KB`);
}

// Run cleanup if this script is run directly
if (require.main === module) {
    cleanup();
}

module.exports = cleanup; 