const AUTO_REFRESH_INTERVAL = 5 * 60 * 1000;
const MAX_SUGGESTIONS = 5;
const RESULTS_PER_PAGE = 10;
const DEBOUNCE_DELAY = 250;

let schoolData = [];
let lastFetchTime = null;
let autoRefreshTimer = null;
let currentPage = 1;
let currentMatches = [];
let activeSuggestionIndex = -1;
let debounceTimer = null;
let currentToast = null;

function escapeHTML(str) {
    if (!str || str === 'NA') return str;
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function filterSchools(query) {
    if (!query) return [];
    const q = query.toLowerCase();
    return schoolData.filter(school =>
        (school["SCHOOL CODE"] || '').toLowerCase().includes(q) ||
        (school["NAME OF INSTITUTION"] || '').toLowerCase().includes(q) ||
        (school["NAME OF CANDIDATES"] || '').toLowerCase().includes(q) ||
        (school["DISTRICT"] || '').toLowerCase().includes(q) ||
        (school["BLOCK"] || '').toLowerCase().includes(q)
    );
}

async function fetchGoogleSheetData() {
    const url = '/.netlify/functions/get-sheet-data';
    try {
        const response = await fetch(url);
        const data = await response.json();
        if (!response.ok) {
            throw new Error(data.error || `HTTP ${response.status}`);
        }
        return data.values;
    } catch (error) {
        console.error('Error fetching data:', error);
        throw error;
    }
}

function convertToJSON(sheetData) {
    if (!sheetData || sheetData.length < 2) {
        throw new Error('Sheet is empty or has no data');
    }
    const headers = sheetData[0];
    const rows = sheetData.slice(1);
    return rows.map(row => {
        const obj = {};
        headers.forEach((header, index) => {
            obj[header] = row[index] || 'NA';
        });
        return obj;
    }).filter(row => Object.values(row).some(val => val !== 'NA' && val !== ''));
}

function formatTimestamp(date) {
    return date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
}

async function initializeApp() {
    try {
        document.getElementById('loadingIndicator').style.display = 'block';
        document.getElementById('mainContent').style.display = 'none';
        document.getElementById('errorMessage').style.display = 'none';
        updateStatus('Fetching data...', 'loading');
        
        const sheetData = await fetchGoogleSheetData();
        schoolData = convertToJSON(sheetData);
        
        lastFetchTime = new Date();
        updateStatus(`Live • ${schoolData.length} schools • Updated ${formatTimestamp(lastFetchTime)}`, 'success');
        
        document.getElementById('loadingIndicator').style.display = 'none';
        document.getElementById('mainContent').style.display = 'block';
        
        showToast(`✅ ${schoolData.length} schools loaded!`);
        setupAutoRefresh();
    } catch (error) {
        document.getElementById('loadingIndicator').style.display = 'none';
        document.getElementById('errorMessage').style.display = 'block';
        updateStatus('Connection failed', 'error');
        
        let errorMsg = error.message;
        let suggestions = [];
        if (errorMsg.includes('404')) {
            suggestions.push('Sheet name "school master data" check karo');
            suggestions.push('Sheet ID verify karo');
        } else if (errorMsg.includes('403')) {
            suggestions.push('Sheet ko "Anyone with the link" access do');
        } else if (errorMsg.includes('400')) {
            suggestions.push('API Key check karo');
        }
        
        document.getElementById('errorMessage').innerHTML = `
            <strong>⚠️ Error loading data</strong><br>
            <code>${escapeHTML(errorMsg)}</code><br><br>
            ${suggestions.length > 0 ? suggestions.map(s => `• ${s}`).join('<br>') : ''}
            <br><br>
            <button class="btn btn-success" id="retryBtn">🔄 Try Again</button>
        `;
        document.getElementById('retryBtn')?.addEventListener('click', initializeApp);
    }
}

function updateStatus(message, type = 'success') {
    const statusEl = document.getElementById('dataStatus');
    const dotEl = document.querySelector('.status-dot');
    statusEl.textContent = message;
    if (type === 'success') dotEl.style.background = '#28a745';
    else if (type === 'loading') dotEl.style.background = '#ffc107';
    else if (type === 'error') dotEl.style.background = '#dc3545';
}

function setupAutoRefresh() {
    const toggle = document.getElementById('autoRefreshToggle');
    if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; }
    if (toggle.checked) {
        autoRefreshTimer = setInterval(async () => {
            console.log('Auto-refreshing data...');
            await refreshDataSilent();
        }, AUTO_REFRESH_INTERVAL);
    }
}

async function refreshData() {
    const btn = document.getElementById('refreshBtn');
    btn.disabled = true;
    btn.innerHTML = '⏳';
    try {
        await refreshDataSilent();
        showToast('✅ Refreshed!');
    } catch (error) {
        showToast('❌ Failed', true);
    }
    btn.disabled = false;
    btn.innerHTML = '🔄 Refresh';
}

async function refreshDataSilent() {
    try {
        const sheetData = await fetchGoogleSheetData();
        const newData = convertToJSON(sheetData);
        
        // Efficient comparison: check length first, then spot-check first and last rows
        const hasChanged = newData.length !== schoolData.length ||
            JSON.stringify(newData[0]) !== JSON.stringify(schoolData[0]) ||
            JSON.stringify(newData[newData.length - 1]) !== JSON.stringify(schoolData[schoolData.length - 1]);
        
        if (hasChanged) {
            schoolData = newData;
            lastFetchTime = new Date();
            updateStatus(`Updated • ${schoolData.length} schools • ${formatTimestamp(lastFetchTime)}`, 'success');
            
            const searchInput = document.getElementById('searchInput').value;
            if (searchInput.trim()) {
                searchSchool();
            }
        } else {
            lastFetchTime = new Date();
            updateStatus(`Live • ${schoolData.length} schools • Updated ${formatTimestamp(lastFetchTime)}`, 'success');
        }
    } catch (error) {
        console.error('Silent refresh failed:', error);
        throw error;
    }
}

function searchSchool() {
    const input = document.getElementById('searchInput').value.trim();
    const resultsContainer = document.getElementById('results');
    const suggestionBox = document.getElementById('suggestions');
    const resultCountEl = document.getElementById('resultCount');
    const loadMoreContainer = document.getElementById('loadMoreContainer');
    
    suggestionBox.innerHTML = '';
    activeSuggestionIndex = -1;
    
    if (!input) {
        resultsContainer.innerHTML = '';
        resultCountEl.style.display = 'none';
        loadMoreContainer.style.display = 'none';
        return;
    }
    
    currentMatches = filterSchools(input);
    currentPage = 1;
    
    if (currentMatches.length === 0) {
        resultsContainer.innerHTML = '<div class="no-results">No matching school found<br><small>Try different keywords</small></div>';
        resultCountEl.style.display = 'none';
        loadMoreContainer.style.display = 'none';
        return;
    }
    
    // Show result count
    resultCountEl.style.display = 'block';
    resultCountEl.innerHTML = `Showing <strong>${Math.min(RESULTS_PER_PAGE, currentMatches.length)}</strong> of <strong>${currentMatches.length}</strong> results for "<strong>${escapeHTML(input)}</strong>"`;
    
    // Render first page
    renderResults();
    
    // Scroll to results, not top
    resultCountEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderResults() {
    const resultsContainer = document.getElementById('results');
    const loadMoreContainer = document.getElementById('loadMoreContainer');
    const resultCountEl = document.getElementById('resultCount');
    const input = document.getElementById('searchInput').value.trim();
    
    const endIndex = currentPage * RESULTS_PER_PAGE;
    const visibleMatches = currentMatches.slice(0, endIndex);
    
    resultsContainer.innerHTML = visibleMatches.map((school, index) => `
        <div class="school-card">
            <div class="section-title">🏫 School Details</div>
            <div class="info-grid">
                <div class="info-item">
                    <div class="label">SCHOOL CODE</div>
                    <div class="value">${escapeHTML(school["SCHOOL CODE"]) || "NA"}</div>
                </div>
                <div class="info-item">
                    <div class="label">Project Name</div>
                    <div class="value">${escapeHTML(school["Project Name"]) || "NA"}</div>
                </div>
                <div class="info-item">
                    <div class="label">UDISE CODE</div>
                    <div class="value">${escapeHTML(school["UDISE CODE"]) || "NA"}</div>
                </div>
                <div class="info-item">
                    <div class="label">BLOCK</div>
                    <div class="value">${escapeHTML(school["BLOCK"]) || "NA"}</div>
                </div>
                <div class="info-item">
                    <div class="label">DISTRICT</div>
                    <div class="value">${escapeHTML(school["DISTRICT"]) || "NA"}</div>
                </div>
                <div class="info-item">
                    <div class="label">NAME OF CC_DEF</div>
                    <div class="value">${escapeHTML(school["NAME OF CC_DEF"]) || "NA"}</div>
                </div>
                <div class="info-item">
                    <div class="label">NAME OF INSTITUTION</div>
                    <div class="value"><strong>${escapeHTML(school["NAME OF INSTITUTION"]) || "NA"}</strong></div>
                </div>
                <div class="info-item">
                    <div class="label">NAME OF HEAD MASTER</div>
                    <div class="value">${escapeHTML(school["NAME OF HEAD MASTER"]) || "NA"}</div>
                </div>
                <div class="info-item">
                    <div class="label">HEAD MASTER MOBILE NO</div>
                    <div class="value">${school["HEAD MASTER MOBILE NO"] && school["HEAD MASTER MOBILE NO"] !== "NA" ? `<a href="tel:${escapeHTML(school["HEAD MASTER MOBILE NO"])}">${escapeHTML(school["HEAD MASTER MOBILE NO"])}</a>` : "NA"}</div>
                </div>
            </div>

            <div class="section-title">👤 Candidate Details</div>
            <div class="info-grid">
                <div class="info-item">
                    <div class="label">DATE OF JOINING</div>
                    <div class="value">${escapeHTML(school["DATE OF JOINING"]) || "NA"}</div>
                </div>
                <div class="info-item">
                    <div class="label">NAME OF CANDIDATES</div>
                    <div class="value"><strong>${escapeHTML(school["NAME OF CANDIDATES"]) || "NA"}</strong></div>
                </div>
                <div class="info-item">
                    <div class="label">MOBILE NO.</div>
                    <div class="value">${school["MOBILE NO."] && school["MOBILE NO."] !== "NA" ? `<a href="tel:${escapeHTML(school["MOBILE NO."])}">${escapeHTML(school["MOBILE NO."])}</a>` : "NA"}</div>
                </div>
                <div class="info-item">
                    <div class="label">SECONDARY MOBILE NO</div>
                    <div class="value">${school["SECONDARY MOBILE NO"] && school["SECONDARY MOBILE NO"] !== "NA" ? `<a href="tel:${escapeHTML(school["SECONDARY MOBILE NO"])}">${escapeHTML(school["SECONDARY MOBILE NO"])}</a>` : "NA"}</div>
                </div>
                <div class="info-item">
                    <div class="label">EMAIL ID</div>
                    <div class="value">${school["EMAIL ID"] && school["EMAIL ID"] !== "NA" ? `<a href="mailto:${escapeHTML(school["EMAIL ID"])}">${escapeHTML(school["EMAIL ID"])}</a>` : "NA"}</div>
                </div>
            </div>

            <div class="section-title">📍 Location Details</div>
            <div class="info-grid">
                <div class="info-item">
                    <div class="label">Latitude</div>
                    <div class="value">${escapeHTML(school["Latitude"]) || "NA"}</div>
                </div>
                <div class="info-item">
                    <div class="label">Longitude</div>
                    <div class="value">${escapeHTML(school["Longitude"]) || "NA"}</div>
                </div>
                <div class="info-item">
                    <div class="label">Google Map</div>
                    <div class="value">
                        ${school["Google Map Link"] && school["Google Map Link"] !== "NA"
                            ? `<a href="${escapeHTML(school["Google Map Link"])}" target="_blank" rel="noopener noreferrer">View on Map 🗺️</a>`
                            : "NA"}
                    </div>
                </div>
            </div>

            <div class="copy-buttons">
                <button class="copy-btn copy-basic-btn" data-copy-type="basic" data-index="${index}">📋 Copy Basic</button>
                <button class="copy-btn copy-full-btn" data-copy-type="full" data-index="${index}">📄 Copy Full</button>
            </div>
        </div>
    `).join('');
    
    // Update result count with visible count
    resultCountEl.innerHTML = `Showing <strong>${visibleMatches.length}</strong> of <strong>${currentMatches.length}</strong> results for "<strong>${escapeHTML(input)}</strong>"`;
    
    // Show/hide load more button
    if (endIndex < currentMatches.length) {
        loadMoreContainer.style.display = 'block';
        document.getElementById('loadMoreBtn').textContent = `Load More (${currentMatches.length - endIndex} remaining)`;
    } else {
        loadMoreContainer.style.display = 'none';
    }
}

function loadMore() {
    currentPage++;
    renderResults();
}

function handleCopyClick(e) {
    const btn = e.target.closest('[data-copy-type]');
    if (!btn) return;
    
    const type = btn.dataset.copyType;
    const index = parseInt(btn.dataset.index, 10);
    
    // Error boundary: validate index
    const endIndex = currentPage * RESULTS_PER_PAGE;
    const visibleMatches = currentMatches.slice(0, endIndex);
    
    if (index < 0 || index >= visibleMatches.length) {
        showToast('❌ Data changed, please search again', true);
        return;
    }
    
    const school = visibleMatches[index];
    if (!school) {
        showToast('❌ School data not found, please search again', true);
        return;
    }
    
    if (type === 'basic') {
        copyBasic(school);
    } else {
        copyFull(school);
    }
}

function copyBasic(school) {
    const basicText = `
══════════════════════════
🏫 SCHOOL DETAILS
══════════════════════════

SCHOOL CODE: ${school["SCHOOL CODE"] || "NA"}
Project Name: ${school["Project Name"] || "NA"}
UDISE CODE: ${school["UDISE CODE"] || "NA"}
BLOCK: ${school["BLOCK"] || "NA"}
DISTRICT: ${school["DISTRICT"] || "NA"}
NAME OF CC_DEF: ${school["NAME OF CC_DEF"] || "NA"}
NAME OF INSTITUTION: ${school["NAME OF INSTITUTION"] || "NA"}
NAME OF HEAD MASTER: ${school["NAME OF HEAD MASTER"] || "NA"}
HEAD MASTER MOBILE NO: ${school["HEAD MASTER MOBILE NO"] || "NA"}

══════════════════════════
👤 CANDIDATE DETAILS
══════════════════════════

NAME OF CANDIDATES: ${school["NAME OF CANDIDATES"] || "NA"}
MOBILE NO.: ${school["MOBILE NO."] || "NA"}
SECONDARY MOBILE NO: ${school["SECONDARY MOBILE NO"] || "NA"}
EMAIL ID: ${school["EMAIL ID"] || "NA"}
══════════════════════════`.trim();

    copyToClipboard(basicText, 'basic');
}

function copyFull(school) {
    const fullText = `
══════════════════════════
🏫 SCHOOL DETAILS
══════════════════════════

SCHOOL CODE: ${school["SCHOOL CODE"] || "NA"}
Project Name: ${school["Project Name"] || "NA"}
UDISE CODE: ${school["UDISE CODE"] || "NA"}
BLOCK: ${school["BLOCK"] || "NA"}
DISTRICT: ${school["DISTRICT"] || "NA"}
NAME OF CC_DEF: ${school["NAME OF CC_DEF"] || "NA"}
NAME OF INSTITUTION: ${school["NAME OF INSTITUTION"] || "NA"}
NAME OF HEAD MASTER: ${school["NAME OF HEAD MASTER"] || "NA"}
HEAD MASTER MOBILE NO: ${school["HEAD MASTER MOBILE NO"] || "NA"}

══════════════════════════
👤 CANDIDATE DETAILS
══════════════════════════

DATE OF JOINING: ${school["DATE OF JOINING"] || "NA"}
NAME OF CANDIDATES: ${school["NAME OF CANDIDATES"] || "NA"}
MOBILE NO.: ${school["MOBILE NO."] || "NA"}
SECONDARY MOBILE NO: ${school["SECONDARY MOBILE NO"] || "NA"}
EMAIL ID: ${school["EMAIL ID"] || "NA"}

══════════════════════════
📍 LOCATION DETAILS
══════════════════════════

Latitude: ${school["Latitude"] || "NA"}
Longitude: ${school["Longitude"] || "NA"}
Google Map Link: ${school["Google Map Link"] || "NA"}
══════════════════════════`.trim();

    copyToClipboard(fullText, 'full');
}

function copyToClipboard(text, type) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => {
            showToast(`✅ ${type === 'basic' ? 'Basic' : 'Full'} copied!`);
        }).catch(() => {
            fallbackCopy(text, type);
        });
    } else {
        fallbackCopy(text, type);
    }
}

function fallbackCopy(text, type) {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.left = '-9999px';
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    try {
        document.execCommand('copy');
        showToast(`✅ ${type === 'basic' ? 'Basic' : 'Full'} copied!`);
    } catch (err) {
        showToast('❌ Copy failed', true);
    }
    document.body.removeChild(textArea);
}

function debouncedSuggest() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(suggestSchools, DEBOUNCE_DELAY);
}

function suggestSchools() {
    const input = document.getElementById('searchInput').value.trim();
    const suggestionBox = document.getElementById('suggestions');
    activeSuggestionIndex = -1;
    
    if (!input) {
        suggestionBox.innerHTML = '';
        return;
    }
    
    const suggestions = filterSchools(input).slice(0, MAX_SUGGESTIONS);
    
    if (suggestions.length === 0) {
        suggestionBox.innerHTML = '';
        return;
    }
    
    suggestionBox.innerHTML = suggestions.map((school, i) => {
        const code = escapeHTML(school["SCHOOL CODE"] || 'NA');
        const name = escapeHTML(school["NAME OF INSTITUTION"] || 'NA');
        const candidate = school["NAME OF CANDIDATES"] && school["NAME OF CANDIDATES"] !== 'NA' 
            ? `👤 ${escapeHTML(school["NAME OF CANDIDATES"])} • ` : '';
        const district = escapeHTML(school["DISTRICT"] || 'NA');
        const dataValue = escapeHTML(school["SCHOOL CODE"] || school["NAME OF INSTITUTION"] || '');
        
        return `<div class="suggestion-item" data-suggestion-value="${dataValue}" data-index="${i}">
            <strong>${code}</strong>
            ${name}
            <small>${candidate}📍 ${district}</small>
        </div>`;
    }).join('');
}

function dismissSuggestions() {
    document.getElementById('suggestions').innerHTML = '';
    activeSuggestionIndex = -1;
}

function handleKeyboardNav(event) {
    const suggestionBox = document.getElementById('suggestions');
    const items = suggestionBox.querySelectorAll('.suggestion-item');
    
    if (items.length === 0) {
        if (event.key === 'Enter') {
            searchSchool();
        }
        return;
    }
    
    if (event.key === 'ArrowDown') {
        event.preventDefault();
        activeSuggestionIndex = Math.min(activeSuggestionIndex + 1, items.length - 1);
        updateActiveSuggestion(items);
    } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        activeSuggestionIndex = Math.max(activeSuggestionIndex - 1, -1);
        updateActiveSuggestion(items);
    } else if (event.key === 'Enter') {
        event.preventDefault();
        if (activeSuggestionIndex >= 0 && activeSuggestionIndex < items.length) {
            const value = items[activeSuggestionIndex].dataset.suggestionValue;
            selectSuggestion(value);
        } else {
            searchSchool();
        }
    } else if (event.key === 'Escape') {
        dismissSuggestions();
    }
}

function updateActiveSuggestion(items) {
    items.forEach((item, i) => {
        item.classList.toggle('active', i === activeSuggestionIndex);
    });
    if (activeSuggestionIndex >= 0) {
        items[activeSuggestionIndex].scrollIntoView({ block: 'nearest' });
    }
}

function selectSuggestion(value) {
    document.getElementById('searchInput').value = value;
    dismissSuggestions();
    searchSchool();
}

function showToast(message, isError = false) {
    // Remove existing toast to prevent stacking
    if (currentToast) {
        currentToast.remove();
        currentToast = null;
    }
    
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    if (isError) toast.style.backgroundColor = '#dc3545';
    document.body.appendChild(toast);
    currentToast = toast;
    
    setTimeout(() => {
        if (currentToast === toast) {
            toast.remove();
            currentToast = null;
        }
    }, 3000);
}

function toggleDarkMode() {
    const html = document.documentElement;
    const btn = document.getElementById('darkModeToggle');
    const isDark = html.getAttribute('data-theme') === 'dark';
    
    if (isDark) {
        html.removeAttribute('data-theme');
        btn.textContent = '🌙';
        localStorage.setItem('theme', 'light');
    } else {
        html.setAttribute('data-theme', 'dark');
        btn.textContent = '☀️';
        localStorage.setItem('theme', 'dark');
    }
}

function loadTheme() {
    const saved = localStorage.getItem('theme');
    const btn = document.getElementById('darkModeToggle');
    if (saved === 'dark') {
        document.documentElement.setAttribute('data-theme', 'dark');
        btn.textContent = '☀️';
    }
}

function resetSearch() {
    document.getElementById('searchInput').value = '';
    document.getElementById('results').innerHTML = '';
    document.getElementById('suggestions').innerHTML = '';
    document.getElementById('resultCount').style.display = 'none';
    document.getElementById('loadMoreContainer').style.display = 'none';
    currentMatches = [];
    currentPage = 1;
    activeSuggestionIndex = -1;
}

document.addEventListener('DOMContentLoaded', () => {
    // Load saved theme
    loadTheme();
    
    // Search input events
    const searchInput = document.getElementById('searchInput');
    searchInput.addEventListener('input', debouncedSuggest);
    searchInput.addEventListener('keydown', handleKeyboardNav);
    
    // Button events
    document.getElementById('searchBtn').addEventListener('click', searchSchool);
    document.getElementById('resetBtn').addEventListener('click', resetSearch);
    document.getElementById('refreshBtn').addEventListener('click', refreshData);
    document.getElementById('darkModeToggle').addEventListener('click', toggleDarkMode);
    document.getElementById('loadMoreBtn').addEventListener('click', loadMore);
    
    // Auto-refresh toggle
    const toggle = document.getElementById('autoRefreshToggle');
    toggle.addEventListener('change', () => {
        if (toggle.checked) {
            showToast('🔄 Auto-refresh ON');
            setupAutoRefresh();
        } else {
            showToast('⏸️ Auto-refresh OFF');
            if (autoRefreshTimer) {
                clearInterval(autoRefreshTimer);
                autoRefreshTimer = null;
            }
        }
    });
    
    // Dismiss suggestions on outside click
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.search-box') && !e.target.closest('#suggestions')) {
            dismissSuggestions();
        }
    });
    
    // Event delegation for suggestion clicks (no inline onclick)
    document.getElementById('suggestions').addEventListener('click', (e) => {
        const item = e.target.closest('.suggestion-item');
        if (item) {
            selectSuggestion(item.dataset.suggestionValue);
        }
    });
    
    // Event delegation for copy buttons (no inline onclick)
    document.getElementById('results').addEventListener('click', handleCopyClick);
    
    // Cleanup on page unload
    window.addEventListener('beforeunload', () => {
        if (autoRefreshTimer) clearInterval(autoRefreshTimer);
    });
    
    // Initialize app
    initializeApp();
});
