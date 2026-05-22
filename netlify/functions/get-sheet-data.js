exports.handler = async (event, context) => {
    const API_KEY = process.env.GOOGLE_API_KEY;
    const SPREADSHEET_ID = '1a-J8Xy4V9xDxzciRAEL1BfnDSBUxHqs57zZZBfQ7ZMg';
    const SHEET_NAME = 'school master data';

    if (!API_KEY) {
        return {
            statusCode: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'API key not configured. Set GOOGLE_API_KEY in Netlify environment variables.' })
        };
    }

    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(SHEET_NAME)}?key=${API_KEY}`;

    try {
        const response = await fetch(url);
        const data = await response.json();

        if (!response.ok) {
            return {
                statusCode: response.status,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: data.error?.message || `Google Sheets API error: HTTP ${response.status}` })
            };
        }

        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'public, max-age=60'
            },
            body: JSON.stringify(data)
        };
    } catch (error) {
        return {
            statusCode: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'Failed to fetch data from Google Sheets: ' + error.message })
        };
    }
};
