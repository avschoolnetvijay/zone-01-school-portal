const AUTO_REFRESH_INTERVAL = 5 * 60 * 1000;
const MAX_SUGGESTIONS = 5;
const RESULTS_PER_PAGE = 10;
const DEBOUNCE_DELAY = 250;

let schoolData = [];
let lastFetchTime = null;
let autoRefreshTimer = null;
let currentPage = 1;
let currentMatches = [];
let selectedSchools = new Set(); // Store indices of selected schools
let activeSuggestionIndex = -1;
let debounceTimer = null;
let currentToast = null;
let myChart = null; // Chart.js instance

// All available columns for export
const EXPORT_COLUMNS = [
    "SCHOOL CODE", "Project Name", "UDISE CODE", "BLOCK", "DISTRICT",
    "NAME OF CC_DEF", "NAME OF INSTITUTION", "NAME OF HEAD MASTER",
    "HEAD MASTER MOBILE NO", "DATE OF JOINING", "NAME OF CANDIDATES",
    "MOBILE NO.", "SECONDARY MOBILE NO", "EMAIL ID", "Latitude", "Longitude", "Google Map Link"
];
// Default selected columns for export
let selectedExportColumns = new Set(EXPORT_COLUMNS);

// --- Initialization & Data Fetching ---

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
        
        // Initialize all features
        populateFilterDropdowns();
        buildDashboard();
        renderColumnChooser();
        loadSavedFilters();
        
        setupAutoRefresh();
    } catch (error) {
        document.getElementById('loadingIndicator').style.display = 'none';
        document.getElementById('errorMessage').style.display = 'block';
        updateStatus('Connection failed', 'error');
        document.getElementById('errorMessage').innerHTML = `
            <strong>⚠️ Error loading data</strong><br>
            <code>${escapeHTML(error.message)}</code><br><br>
            <button class="btn btn-success" id="retryBtn">🔄 Try Again</button>
        `;
        document.getElementById('retryBtn')?.addEventListener('click', initializeApp);
    }
}

async function fetchGoogleSheetData() {
    const url = '/.netlify/functions/get-sheet-data';
    const response = await fetch(url);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data.values;
}

function convertToJSON(sheetData) {
    if (!sheetData || sheetData.length < 2) throw new Error('Sheet is empty');
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

// --- Tab Navigation ---

function switchTab(targetId) {
    document.querySelectorAll('.view-section').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
    
    document.getElementById(targetId).classList.add('active');
    document.querySelector(`[data-target="${targetId}"]`).classList.add('active');
}

// --- Dashboard Logic ---

function buildDashboard() {
    // Top KPIs
    document.getElementById('kpiSchools').textContent = schoolData.length;
    const districts = new Set(schoolData.map(s => s["DISTRICT"]).filter(d => d && d !== 'NA'));
    document.getElementById('kpiDistricts').textContent = districts.size;
    const blocks = new Set(schoolData.map(s => s["BLOCK"]).filter(b => b && b !== 'NA'));
    document.getElementById('kpiBlocks').textContent = blocks.size;
    const candidates = new Set(schoolData.map(s => s["NAME OF CANDIDATES"]).filter(c => c && c !== 'NA'));
    document.getElementById('kpiCandidates').textContent = candidates.size;

    // Project-wise Summary
    const projectCounts = {};
    schoolData.forEach(s => {
        const proj = s["Project Name"] || 'Unknown';
        if (proj !== 'NA') {
            projectCounts[proj] = (projectCounts[proj] || 0) + 1;
        }
    });

    const projectContainer = document.getElementById('projectCardsContainer');
    projectContainer.innerHTML = '';
    const labels = [];
    const data = [];
    const backgroundColors = ['#667eea', '#764ba2', '#89b4fa', '#cba6f7', '#a6e3a1', '#f9e2af'];

    Object.entries(projectCounts)
        .sort((a, b) => b[1] - a[1]) // Sort by count desc
        .forEach(([proj, count], index) => {
            labels.push(proj);
            data.push(count);
            const percent = ((count / schoolData.length) * 100).toFixed(1);
            
            projectContainer.innerHTML += `
                <div class="project-card clickable" data-filter-type="project" data-filter-value="${escapeHTML(proj)}" style="background-color: ${backgroundColors[index % backgroundColors.length]}">
                    <div class="project-card-header">
                        <span>${escapeHTML(proj)}</span>
                        <span>${percent}%</span>
                    </div>
                    <div class="project-card-value">${count}</div>
                </div>
            `;
    });

    // Chart.js rendering
    const ctx = document.getElementById('projectChart').getContext('2d');
    if (myChart) myChart.destroy();
    
    // Check if theme is dark
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const textColor = isDark ? '#cdd6f4' : '#333';

    myChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: labels,
            datasets: [{
                data: data,
                backgroundColor: backgroundColors,
                borderWidth: 0
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { position: 'right', labels: { color: textColor } }
            }
        }
    });

    // Hierarchical View (Project -> District -> CC -> Institution)
    buildHierarchicalView();
}

function buildHierarchicalView() {
    const hierarchy = {};
    
    schoolData.forEach(s => {
        const proj = (s["Project Name"] && s["Project Name"] !== 'NA') ? s["Project Name"] : 'Unknown Project';
        const dist = (s["DISTRICT"] && s["DISTRICT"] !== 'NA') ? s["DISTRICT"] : 'Unknown District';
        const cc = (s["NAME OF CC_DEF"] && s["NAME OF CC_DEF"] !== 'NA') ? s["NAME OF CC_DEF"] : 'Unknown CC';
        const inst = s["NAME OF INSTITUTION"] || 'Unknown Institution';
        const code = s["SCHOOL CODE"] || '';

        if (!hierarchy[proj]) hierarchy[proj] = { count: 0, districts: {} };
        hierarchy[proj].count++;
        
        if (!hierarchy[proj].districts[dist]) hierarchy[proj].districts[dist] = { count: 0, ccs: {} };
        hierarchy[proj].districts[dist].count++;
        
        if (!hierarchy[proj].districts[dist].ccs[cc]) hierarchy[proj].districts[dist].ccs[cc] = { count: 0, schools: [] };
        hierarchy[proj].districts[dist].ccs[cc].count++;
        
        hierarchy[proj].districts[dist].ccs[cc].schools.push({ name: inst, code: code });
    });

    const container = document.getElementById('hierarchyContainer');
    let html = '';

    // Recursive HTML generator
    Object.keys(hierarchy).sort().forEach(proj => {
        html += `
        <div class="hierarchy-item">
            <div class="hierarchy-header" onclick="toggleAccordion(this)">
                <div><span class="caret">▶</span> 📦 ${escapeHTML(proj)}</div>
                <span class="count-badge">${hierarchy[proj].count}</span>
            </div>
            <div class="hierarchy-children">
        `;
        
        Object.keys(hierarchy[proj].districts).sort().forEach(dist => {
            html += `
            <div class="hierarchy-item">
                <div class="hierarchy-header" onclick="toggleAccordion(this)">
                    <div><span class="caret">▶</span> 📍 ${escapeHTML(dist)}</div>
                    <span class="count-badge">${hierarchy[proj].districts[dist].count}</span>
                </div>
                <div class="hierarchy-children">
            `;
            
            Object.keys(hierarchy[proj].districts[dist].ccs).sort().forEach(cc => {
                html += `
                <div class="hierarchy-item">
                    <div class="hierarchy-header" onclick="toggleAccordion(this)">
                        <div><span class="caret">▶</span> 👤 ${escapeHTML(cc)}</div>
                        <span class="count-badge">${hierarchy[proj].districts[dist].ccs[cc].count}</span>
                    </div>
                    <div class="hierarchy-children">
                `;
                
                hierarchy[proj].districts[dist].ccs[cc].schools.sort((a,b) => a.name.localeCompare(b.name)).forEach(school => {
                    html += `
                    <div class="hierarchy-item">
                        <div class="hierarchy-header clickable" style="border:none; padding:4px 8px; font-size: 11px;" 
                             data-filter-type="school" data-filter-value="${escapeHTML(school.code)}">
                            <div>🏫 ${escapeHTML(school.name)} (${escapeHTML(school.code)})</div>
                        </div>
                    </div>
                    `;
                });
                
                html += `</div></div>`; // End CC
            });
            html += `</div></div>`; // End District
        });
        html += `</div></div>`; // End Project
    });

    container.innerHTML = html;
}

function toggleAccordion(el) {
    const caret = el.querySelector('.caret');
    const children = el.nextElementSibling;
    if (caret && children) {
        caret.classList.toggle('open');
        children.classList.toggle('open');
    }
}

// Clickable KPIs and Dashboard items
document.addEventListener('click', (e) => {
    const clickable = e.target.closest('.clickable');
    if (!clickable) return;
    
    const type = clickable.dataset.filterType;
    const val = clickable.dataset.filterValue;
    
    resetSearch(false); // Reset but don't clear UI completely yet
    
    if (type === 'project') {
        document.getElementById('filterProject').value = val;
    } else if (type === 'school') {
        document.getElementById('searchInput').value = val;
    }
    // if 'all', just clear filters (handled by resetSearch)
    
    switchTab('searchView');
    searchSchool();
});


// --- Search & Filters Logic ---

function populateFilterDropdowns() {
    const projects = new Set();
    const districts = new Set();
    const ccs = new Set();
    const blocks = new Set();

    schoolData.forEach(s => {
        if (s["Project Name"] && s["Project Name"] !== 'NA') projects.add(s["Project Name"]);
        if (s["DISTRICT"] && s["DISTRICT"] !== 'NA') districts.add(s["DISTRICT"]);
        if (s["NAME OF CC_DEF"] && s["NAME OF CC_DEF"] !== 'NA') ccs.add(s["NAME OF CC_DEF"]);
        if (s["BLOCK"] && s["BLOCK"] !== 'NA') blocks.add(s["BLOCK"]);
    });

    const fillDropdown = (id, set) => {
        const select = document.getElementById(id);
        const options = Array.from(set).sort().map(val => `<option value="${escapeHTML(val)}">${escapeHTML(val)}</option>`).join('');
        select.innerHTML = `<option value="">All</option>` + options;
    };

    fillDropdown('filterProject', projects);
    fillDropdown('filterDistrict', districts);
    fillDropdown('filterCC', ccs);
    fillDropdown('filterBlock', blocks);
}

function searchSchool() {
    const input = document.getElementById('searchInput').value.trim().toLowerCase();
    const filterProject = document.getElementById('filterProject').value;
    const filterDistrict = document.getElementById('filterDistrict').value;
    const filterCC = document.getElementById('filterCC').value;
    const filterBlock = document.getElementById('filterBlock').value;
    const sortBy = document.getElementById('sortSelect').value;
    
    const resultsContainer = document.getElementById('results');
    const resultCountEl = document.getElementById('resultCount');
    const loadMoreContainer = document.getElementById('loadMoreContainer');
    
    document.getElementById('suggestions').innerHTML = '';
    activeSuggestionIndex = -1;
    
    currentMatches = schoolData.filter(school => {
        // Text Match
        let textMatch = true;
        if (input) {
            textMatch = (school["SCHOOL CODE"] || '').toLowerCase().includes(input) ||
                        (school["NAME OF INSTITUTION"] || '').toLowerCase().includes(input) ||
                        (school["NAME OF CANDIDATES"] || '').toLowerCase().includes(input);
        }
        
        // Dropdown Match
        const projMatch = filterProject === "" || school["Project Name"] === filterProject;
        const distMatch = filterDistrict === "" || school["DISTRICT"] === filterDistrict;
        const ccMatch = filterCC === "" || school["NAME OF CC_DEF"] === filterCC;
        const blockMatch = filterBlock === "" || school["BLOCK"] === filterBlock;
        
        return textMatch && projMatch && distMatch && ccMatch && blockMatch;
    });

    // Sorting
    if (sortBy === "School Code") {
        currentMatches.sort((a,b) => (a["SCHOOL CODE"]||'').localeCompare(b["SCHOOL CODE"]||''));
    } else if (sortBy === "Institution Name") {
        currentMatches.sort((a,b) => (a["NAME OF INSTITUTION"]||'').localeCompare(b["NAME OF INSTITUTION"]||''));
    } else if (sortBy === "District") {
        currentMatches.sort((a,b) => (a["DISTRICT"]||'').localeCompare(b["DISTRICT"]||''));
    }
    
    currentPage = 1;
    selectedSchools.clear(); // Clear selection on new search
    updateSelectAllButton();
    
    if (currentMatches.length === 0) {
        resultsContainer.innerHTML = '<div class="no-results">No matching school found</div>';
        resultCountEl.style.display = 'none';
        loadMoreContainer.style.display = 'none';
        return;
    }
    
    resultCountEl.style.display = 'block';
    renderResults();
}

function renderResults() {
    const resultsContainer = document.getElementById('results');
    const loadMoreContainer = document.getElementById('loadMoreContainer');
    const resultCountEl = document.getElementById('resultCount');
    
    const endIndex = currentPage * RESULTS_PER_PAGE;
    const visibleMatches = currentMatches.slice(0, endIndex);
    
    if (currentPage === 1) resultsContainer.innerHTML = ''; // Clear if first page
    
    const html = visibleMatches.slice((currentPage-1)*RESULTS_PER_PAGE).map((school, i) => {
        const actualIndex = (currentPage-1)*RESULTS_PER_PAGE + i;
        const isSelected = selectedSchools.has(actualIndex);
        
        return `
        <div class="school-card ${isSelected ? 'selected' : ''}" data-index="${actualIndex}">
            <div class="card-header-row">
                <div class="card-header-left">
                    <input type="checkbox" class="card-checkbox" data-index="${actualIndex}" ${isSelected ? 'checked' : ''}>
                    <div class="section-title" style="margin:0; border:none; padding:0;">🏫 ${escapeHTML(school["NAME OF INSTITUTION"] || "NA")}</div>
                </div>
            </div>
            
            <div class="info-grid">
                <div class="info-item"><div class="label">SCHOOL CODE</div><div class="value">${escapeHTML(school["SCHOOL CODE"]) || "NA"}</div></div>
                <div class="info-item"><div class="label">Project Name</div><div class="value">${escapeHTML(school["Project Name"]) || "NA"}</div></div>
                <div class="info-item"><div class="label">UDISE CODE</div><div class="value">${escapeHTML(school["UDISE CODE"]) || "NA"}</div></div>
                <div class="info-item"><div class="label">DISTRICT / BLOCK</div><div class="value">${escapeHTML(school["DISTRICT"])} / ${escapeHTML(school["BLOCK"])}</div></div>
                <div class="info-item"><div class="label">NAME OF CC_DEF</div><div class="value">${escapeHTML(school["NAME OF CC_DEF"]) || "NA"}</div></div>
            </div>

            <div class="info-grid" style="background: rgba(0,0,0,0.02); padding: 10px; border-radius: 8px;">
                <div class="info-item"><div class="label">CANDIDATE</div><div class="value"><strong>${escapeHTML(school["NAME OF CANDIDATES"]) || "NA"}</strong></div></div>
                <div class="info-item"><div class="label">MOBILE</div><div class="value">${school["MOBILE NO."] && school["MOBILE NO."] !== "NA" ? `<a href="tel:${escapeHTML(school["MOBILE NO."])}">${escapeHTML(school["MOBILE NO."])}</a>` : "NA"}</div></div>
                <div class="info-item"><div class="label">HEAD MASTER</div><div class="value">${escapeHTML(school["NAME OF HEAD MASTER"]) || "NA"}</div></div>
            </div>
            
            <div class="copy-buttons" style="border:none; padding:0; margin-top:10px;">
                <button class="copy-btn btn-outline" style="color:var(--text-primary);" data-copy-type="full" data-index="${actualIndex}">📄 Copy Details</button>
            </div>
        </div>
    `}).join('');
    
    if (currentPage === 1) {
        resultsContainer.innerHTML = html;
    } else {
        resultsContainer.insertAdjacentHTML('beforeend', html);
    }
    
    resultCountEl.innerHTML = `Showing <strong>${Math.min(endIndex, currentMatches.length)}</strong> of <strong>${currentMatches.length}</strong> results`;
    
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

function resetSearch(clearUI = true) {
    document.getElementById('searchInput').value = '';
    document.getElementById('filterProject').value = '';
    document.getElementById('filterDistrict').value = '';
    document.getElementById('filterCC').value = '';
    document.getElementById('filterBlock').value = '';
    document.getElementById('sortSelect').value = 'School Code';
    
    if (clearUI) {
        document.getElementById('results').innerHTML = '';
        document.getElementById('suggestions').innerHTML = '';
        document.getElementById('resultCount').style.display = 'none';
        document.getElementById('loadMoreContainer').style.display = 'none';
        currentMatches = [];
        currentPage = 1;
        selectedSchools.clear();
        updateSelectAllButton();
    }
}

// --- Checkbox Selection ---

function handleCardClick(e) {
    // Handle Checkbox click
    if (e.target.classList.contains('card-checkbox')) {
        const idx = parseInt(e.target.dataset.index, 10);
        const card = document.querySelector(`.school-card[data-index="${idx}"]`);
        if (e.target.checked) {
            selectedSchools.add(idx);
            if(card) card.classList.add('selected');
        } else {
            selectedSchools.delete(idx);
            if(card) card.classList.remove('selected');
        }
        updateSelectAllButton();
    }
    
    // Handle Copy button
    const copyBtn = e.target.closest('[data-copy-type]');
    if (copyBtn) {
        const idx = parseInt(copyBtn.dataset.index, 10);
        copyFull(currentMatches[idx]);
    }
}

function toggleSelectAll() {
    if (currentMatches.length === 0) return;
    
    if (selectedSchools.size === currentMatches.length) {
        // Deselect all
        selectedSchools.clear();
        document.querySelectorAll('.card-checkbox').forEach(cb => cb.checked = false);
        document.querySelectorAll('.school-card').forEach(c => c.classList.remove('selected'));
    } else {
        // Select all matches
        currentMatches.forEach((_, idx) => selectedSchools.add(idx));
        document.querySelectorAll('.card-checkbox').forEach(cb => cb.checked = true);
        document.querySelectorAll('.school-card').forEach(c => c.classList.add('selected'));
    }
    updateSelectAllButton();
}

function updateSelectAllButton() {
    const btn = document.getElementById('selectAllBtn');
    if (selectedSchools.size > 0 && selectedSchools.size === currentMatches.length) {
        btn.innerHTML = '🔲 Deselect All';
    } else {
        btn.innerHTML = '☑️ Select All';
    }
}

// --- Column Chooser & Excel Export ---

function renderColumnChooser() {
    const menu = document.getElementById('columnChooserMenu');
    menu.innerHTML = EXPORT_COLUMNS.map(col => `
        <label class="col-cb-label">
            <input type="checkbox" value="${escapeHTML(col)}" ${selectedExportColumns.has(col) ? 'checked' : ''}>
            ${escapeHTML(col)}
        </label>
    `).join('');
    
    menu.addEventListener('change', (e) => {
        if (e.target.type === 'checkbox') {
            if (e.target.checked) selectedExportColumns.add(e.target.value);
            else selectedExportColumns.delete(e.target.value);
        }
    });
}

function exportExcel(onlySelected = false) {
    if (typeof XLSX === 'undefined') {
        showToast('❌ Excel library loading, please wait...', true);
        return;
    }
    
    const dataToExport = onlySelected 
        ? currentMatches.filter((_, idx) => selectedSchools.has(idx))
        : currentMatches;
        
    if (dataToExport.length === 0) {
        showToast('❌ No data to export', true);
        return;
    }

    // Filter columns
    const filteredData = dataToExport.map(row => {
        const newRow = {};
        EXPORT_COLUMNS.forEach(col => {
            if (selectedExportColumns.has(col)) {
                newRow[col] = row[col];
            }
        });
        return newRow;
    });

    const worksheet = XLSX.utils.json_to_sheet(filteredData);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Schools");
    
    const filename = `Zone01_Schools_${new Date().toISOString().slice(0,10)}.xlsx`;
    XLSX.writeFile(workbook, filename);
    showToast(`✅ Exported ${dataToExport.length} rows to Excel`);
}

// --- Save/Load Filters ---

function saveFilters() {
    const filters = {
        query: document.getElementById('searchInput').value,
        project: document.getElementById('filterProject').value,
        district: document.getElementById('filterDistrict').value,
        cc: document.getElementById('filterCC').value,
        block: document.getElementById('filterBlock').value,
        sort: document.getElementById('sortSelect').value
    };
    localStorage.setItem('savedFilters', JSON.stringify(filters));
    showToast('💾 Filters saved successfully!');
}

function loadSavedFilters() {
    const saved = localStorage.getItem('savedFilters');
    if (saved) {
        try {
            const filters = JSON.parse(saved);
            document.getElementById('searchInput').value = filters.query || '';
            document.getElementById('filterProject').value = filters.project || '';
            document.getElementById('filterDistrict').value = filters.district || '';
            document.getElementById('filterCC').value = filters.cc || '';
            document.getElementById('filterBlock').value = filters.block || '';
            document.getElementById('sortSelect').value = filters.sort || 'School Code';
        } catch(e){}
    }
}


// --- Utility & Base Logic (Copied from before) ---

function escapeHTML(str) {
    if (!str || str === 'NA') return str;
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function formatTimestamp(date) {
    return date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
}

function updateStatus(message, type = 'success') {
    const statusEl = document.getElementById('dataStatus');
    const dotEl = document.querySelector('.status-dot');
    statusEl.textContent = message;
    if (type === 'success') dotEl.style.background = '#28a745';
    else if (type === 'loading') dotEl.style.background = '#ffc107';
    else if (type === 'error') dotEl.style.background = '#dc3545';
}

function showToast(message, isError = false) {
    if (currentToast) { currentToast.remove(); currentToast = null; }
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    if (isError) toast.style.backgroundColor = '#dc3545';
    document.body.appendChild(toast);
    currentToast = toast;
    setTimeout(() => { if (currentToast === toast) { toast.remove(); currentToast = null; } }, 3000);
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
    // Re-render chart for colors
    if (schoolData.length) buildDashboard(); 
}

function loadTheme() {
    const saved = localStorage.getItem('theme');
    const btn = document.getElementById('darkModeToggle');
    if (saved === 'dark') {
        document.documentElement.setAttribute('data-theme', 'dark');
        btn.textContent = '☀️';
    }
}

// Auto Refresh
function setupAutoRefresh() {
    const toggle = document.getElementById('autoRefreshToggle');
    if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; }
    if (toggle.checked) {
        autoRefreshTimer = setInterval(async () => {
            try {
                const sheetData = await fetchGoogleSheetData();
                const newData = convertToJSON(sheetData);
                const hasChanged = newData.length !== schoolData.length ||
                    JSON.stringify(newData[0]) !== JSON.stringify(schoolData[0]);
                if (hasChanged) {
                    schoolData = newData;
                    populateFilterDropdowns();
                    buildDashboard();
                    searchSchool();
                }
                lastFetchTime = new Date();
                updateStatus(`Live • ${schoolData.length} schools • Updated ${formatTimestamp(lastFetchTime)}`);
            } catch (error) { console.error('Silent refresh failed:', error); }
        }, AUTO_REFRESH_INTERVAL);
    }
}

// Copy Logic
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
══════════════════════════`.trim();
    copyToClipboard(fullText);
}
function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => showToast(`✅ Copied!`))
        .catch(() => fallbackCopy(text));
    } else { fallbackCopy(text); }
}
function fallbackCopy(text) {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed'; textArea.style.left = '-9999px';
    document.body.appendChild(textArea); textArea.select();
    try { document.execCommand('copy'); showToast(`✅ Copied!`); } catch (err) { showToast('❌ Copy failed', true); }
    document.body.removeChild(textArea);
}

// Suggestions (Debounced text input)
function debouncedSuggest() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
        const input = document.getElementById('searchInput').value.trim().toLowerCase();
        const suggestionBox = document.getElementById('suggestions');
        activeSuggestionIndex = -1;
        if (!input) { suggestionBox.innerHTML = ''; return; }
        
        const suggestions = schoolData.filter(school => 
            (school["SCHOOL CODE"] || '').toLowerCase().includes(input) ||
            (school["NAME OF INSTITUTION"] || '').toLowerCase().includes(input)
        ).slice(0, MAX_SUGGESTIONS);
        
        suggestionBox.innerHTML = suggestions.map((school, i) => `
            <div class="suggestion-item" data-val="${escapeHTML(school["SCHOOL CODE"])}" data-index="${i}">
                <strong>${escapeHTML(school["SCHOOL CODE"])}</strong> - ${escapeHTML(school["NAME OF INSTITUTION"])}
            </div>
        `).join('');
    }, DEBOUNCE_DELAY);
}

// Initialization Listeners
document.addEventListener('DOMContentLoaded', () => {
    loadTheme();
    
    // Tab switching
    document.getElementById('tabDashboard').addEventListener('click', () => switchTab('dashboardView'));
    document.getElementById('tabSearch').addEventListener('click', () => switchTab('searchView'));
    
    // Search & Filter Events
    document.getElementById('applyFiltersBtn').addEventListener('click', searchSchool);
    document.getElementById('clearFiltersBtn').addEventListener('click', () => resetSearch(true));
    document.getElementById('refreshBtn').addEventListener('click', initializeApp);
    document.getElementById('saveFiltersBtn').addEventListener('click', saveFilters);
    
    // Select & Export Events
    document.getElementById('selectAllBtn').addEventListener('click', toggleSelectAll);
    document.getElementById('exportAllBtn').addEventListener('click', () => exportExcel(false));
    document.getElementById('exportSelectedBtn').addEventListener('click', () => exportExcel(true));
    
    // Column Chooser Toggle
    document.getElementById('columnChooserToggle').addEventListener('click', () => {
        const menu = document.getElementById('columnChooserMenu');
        menu.style.display = menu.style.display === 'none' ? 'grid' : 'none';
    });
    
    // Suggestions and Enter Key
    document.getElementById('searchInput').addEventListener('input', debouncedSuggest);
    document.getElementById('searchInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            document.getElementById('suggestions').innerHTML = '';
            searchSchool();
        }
    });
    document.getElementById('suggestions').addEventListener('click', (e) => {
        const item = e.target.closest('.suggestion-item');
        if (item) {
            document.getElementById('searchInput').value = item.dataset.val;
            document.getElementById('suggestions').innerHTML = '';
            searchSchool();
        }
    });
    
    // Global clicks (close menus)
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.search-box') && !e.target.closest('#suggestions')) {
            document.getElementById('suggestions').innerHTML = '';
        }
        if (!e.target.closest('.column-chooser-wrapper')) {
            document.getElementById('columnChooserMenu').style.display = 'none';
        }
    });
    
    document.getElementById('darkModeToggle').addEventListener('click', toggleDarkMode);
    document.getElementById('loadMoreBtn').addEventListener('click', loadMore);
    document.getElementById('results').addEventListener('click', handleCardClick);
    
    // Start App
    initializeApp();
});
