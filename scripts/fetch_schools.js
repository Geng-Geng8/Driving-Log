/**
 * Standalone Ontario School Data Pipeline (Toronto, Durham, York)
 * Fetches the latest dataset from the Ontario Data Catalogue CKAN API,
 * filters for the 6 target GTA boards, normalizes entries, retains landmarks,
 * and writes to schools.json.
 * 
 * NO EXTERNAL NPM DEPENDENCIES REQUIRED.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CKAN_API_URL = 'https://data.ontario.ca/api/3/action/package_show?id=school-information-and-student-demographics';

const BOARD_MAP = {
  'toronto catholic district school board': 'TCDSB',
  'toronto cdsb': 'TCDSB',
  'toronto district school board': 'TDSB',
  'toronto dsb': 'TDSB',
  'durham catholic district school board': 'DCDSB',
  'durham cdsb': 'DCDSB',
  'durham district school board': 'DDSB',
  'durham dsb': 'DDSB',
  'york catholic district school board': 'YCDSB',
  'york cdsb': 'YCDSB',
  'york region district school board': 'YRDSB',
  'york region dsb': 'YRDSB'
};

const LANDMARKS = [
  { name: "CEC Board Office", address: "80 Sheppard Ave E", city: "North York", board: "TCDSB" },
  { name: "John Street Roundhouse", address: "255 Bremner Blvd", city: "Toronto", board: "GTA" },
  { name: "Toronto City Hall", address: "100 Queen St W", city: "Toronto", board: "GTA" },
  { name: "Metro Hall", address: "55 John St", city: "Toronto", board: "GTA" }
];

function resolveBoardCode(boardName) {
  if (!boardName) return null;
  const lower = boardName.toLowerCase().trim();
  for (const [key, code] of Object.entries(BOARD_MAP)) {
    if (lower === key || lower.includes(key)) {
      return code;
    }
  }
  return null;
}

// Pure Node.js ZIP decompressor using built-in zlib
function extractZipFiles(buf) {
  let eocdOffset = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocdOffset === -1) throw new Error('Invalid ZIP file: End of Central Directory not found');

  const cdOffset = buf.readUInt32LE(eocdOffset + 16);
  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  let pos = cdOffset;
  const files = {};

  for (let i = 0; i < totalEntries; i++) {
    const compMethod = buf.readUInt16LE(pos + 10);
    const compSize = buf.readUInt32LE(pos + 20);
    const fnLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localHeaderOffset = buf.readUInt32LE(pos + 42);
    const fn = buf.toString('utf8', pos + 46, pos + 46 + fnLen);
    files[fn] = { compMethod, compSize, localHeaderOffset };
    pos += 46 + fnLen + extraLen + commentLen;
  }

  function readFile(fn) {
    const info = files[fn];
    if (!info) return null;
    const localOffset = info.localHeaderOffset;
    const lFnLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lFnLen + lExtraLen;
    const compData = buf.subarray(dataStart, dataStart + info.compSize);
    return info.compMethod === 8 ? zlib.inflateRawSync(compData) : compData;
  }

  return { files, readFile };
}

// Parse XLSX without external libraries
function parseXlsxBuffer(buf) {
  const zip = extractZipFiles(buf);
  const sstRaw = zip.readFile('xl/sharedStrings.xml');
  const sharedStrings = [];

  if (sstRaw) {
    const sstXml = sstRaw.toString('utf8');
    const siRegex = /<si>([\s\S]*?)<\/si>/g;
    let siMatch;
    while ((siMatch = siRegex.exec(sstXml)) !== null) {
      const tMatches = siMatch[1].match(/<t[^>]*>([\s\S]*?)<\/t>/g) || [];
      const text = tMatches.map(m => m.replace(/<t[^>]*>/, '').replace(/<\/t>/, '')).join('');
      sharedStrings.push(
        text
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&apos;/g, "'")
      );
    }
  }

  const sheetRaw = zip.readFile('xl/worksheets/sheet1.xml');
  if (!sheetRaw) throw new Error('sheet1.xml not found in XLSX archive');
  const sheetXml = sheetRaw.toString('utf8');

  const rows = [];
  const rowRegex = /<row[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
  let rowMatch;

  while ((rowMatch = rowRegex.exec(sheetXml)) !== null) {
    const rowContent = rowMatch[2];
    const cRegex = /<c[^>]*r="([A-Z]+)\d+"(?:[^>]*t="([^"]+)")?[^>]*>(?:<v>([\s\S]*?)<\/v>)?<\/c>/g;
    let cMatch;
    const cols = {};
    while ((cMatch = cRegex.exec(rowContent)) !== null) {
      const colLetter = cMatch[1];
      const type = cMatch[2];
      const val = cMatch[3];
      cols[colLetter] = type === 's' ? (sharedStrings[parseInt(val, 10)] || '') : (val || '');
    }
    rows.push(cols);
  }

  return rows;
}

// Parse standard CSV text
function parseCsvText(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < text.length && text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        row.push(cell.trim());
        cell = '';
      } else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && i + 1 < text.length && text[i + 1] === '\n') {
          i++;
        }
        row.push(cell.trim());
        cell = '';
        if (row.length > 1 || (row.length === 1 && row[0] !== '')) {
          rows.push(row);
        }
        row = [];
      } else {
        cell += ch;
      }
    }
  }
  if (cell || row.length > 0) {
    row.push(cell.trim());
    rows.push(row);
  }
  return rows;
}

async function main() {
  console.log('1. Connecting to Ontario Data Catalogue CKAN API...');
  console.log('   URL:', CKAN_API_URL);

  const res = await fetch(CKAN_API_URL);
  if (!res.ok) throw new Error(`CKAN API failed with HTTP ${res.status}`);
  const pkgData = await res.json();
  if (!pkgData.success || !pkgData.result || !pkgData.result.resources) {
    throw new Error('Invalid CKAN API response structure');
  }

  const resources = pkgData.result.resources;
  console.log(`   Found ${resources.length} resources in package.`);

  // Find English school information resource (prioritize CSV if available, otherwise XLSX)
  let targetResource = resources.find(r => 
    r.format && r.format.toUpperCase() === 'CSV' && 
    (r.name.toLowerCase().includes('en') || (r.url && r.url.toLowerCase().includes('en')))
  );

  if (!targetResource) {
    targetResource = resources.find(r => 
      r.format && r.format.toUpperCase() === 'CSV'
    );
  }

  if (!targetResource) {
    // Select latest English XLSX
    const xlsxResources = resources.filter(r => 
      r.format && r.format.toUpperCase() === 'XLSX' &&
      (r.name.toLowerCase().includes('en') || (r.url && r.url.toLowerCase().includes('_en')))
    );
    targetResource = xlsxResources[xlsxResources.length - 1] || resources.find(r => r.format && r.format.toUpperCase() === 'XLSX');
  }

  if (!targetResource) {
    throw new Error('No compatible CSV or XLSX resource found in package.');
  }

  console.log(`2. Selected resource: "${targetResource.name}" [${targetResource.format}]`);
  console.log(`   Download URL: ${targetResource.url}`);

  const downloadRes = await fetch(targetResource.url);
  if (!downloadRes.ok) throw new Error(`Resource download failed: HTTP ${downloadRes.status}`);

  const rawBuffer = Buffer.from(await downloadRes.arrayBuffer());
  console.log(`   Downloaded ${(rawBuffer.byteLength / 1024 / 1024).toFixed(2)} MB.`);

  console.log('3. Parsing rows and filtering for Toronto, Durham, and York boards...');
  let parsedSchools = [];

  if (targetResource.format && targetResource.format.toUpperCase() === 'CSV') {
    const csvText = rawBuffer.toString('utf8');
    const rows = parseCsvText(csvText);
    if (rows.length < 2) throw new Error('CSV has insufficient rows');

    const headers = rows[0].map(h => h.toLowerCase());
    const boardIdx = headers.findIndex(h => h.includes('board name'));
    const schoolIdx = headers.findIndex(h => h.includes('school name'));
    const levelIdx = headers.findIndex(h => h.includes('school level'));
    const streetIdx = headers.findIndex(h => h.includes('street'));
    let cityIdx = headers.findIndex(h => h === 'city');
    if (cityIdx === -1) cityIdx = headers.findIndex(h => h.includes('municipality'));

    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const boardCode = resolveBoardCode(r[boardIdx]);
      if (!boardCode) continue;

      const level = String(r[levelIdx] || '').toLowerCase().trim();
      if (level !== 'elementary' && level !== 'secondary') continue;

      const name = String(r[schoolIdx] || '').trim();
      const address = String(r[streetIdx] || '').trim();
      const city = String(r[cityIdx] || '').replace(/,\s*(Town|City|Municipality|Township)\s+of.*$/i, '').trim();

      if (name && address) {
        parsedSchools.push({ name, address, city, board: boardCode });
      }
    }
  } else {
    // Parse XLSX using pure Node.js zip/xml parser
    const rows = parseXlsxBuffer(rawBuffer);
    console.log(`   Extracted ${rows.length} total raw rows from spreadsheet.`);

    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const boardName = r['B'] || '';
      const boardCode = resolveBoardCode(boardName);
      if (!boardCode) continue;

      const level = String(r['H'] || '').toLowerCase().trim();
      if (level !== 'elementary' && level !== 'secondary') continue;

      const name = String(r['E'] || '').trim();
      const address = String(r['M'] || '').trim();
      const city = (String(r['O'] || r['N'] || '')).replace(/,\s*(Town|City|Municipality|Township)\s+of.*$/i, '').trim();

      if (name && address) {
        parsedSchools.push({ name, address, city, board: boardCode });
      }
    }
  }

  console.log(`   Filtered ${parsedSchools.length} schools across target boards.`);

  // 4. Retain Landmarks & Deduplicate
  console.log('4. Retaining non-school landmarks and deduplicating...');
  const combined = [...LANDMARKS, ...parsedSchools];
  const seen = new Set();
  const deduped = [];

  for (const item of combined) {
    const key = `${item.name.toLowerCase().trim()}|${item.address.toLowerCase().trim()}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push({
        name: item.name.trim(),
        address: item.address.trim(),
        city: item.city.trim(),
        board: item.board.trim()
      });
    }
  }

  // Sort alphabetically by name
  deduped.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));

  // Count per board
  const boardCounts = {};
  deduped.forEach(s => {
    boardCounts[s.board] = (boardCounts[s.board] || 0) + 1;
  });

  console.log('\n========================================');
  console.log('FINAL GTA SCHOOL & LANDMARK SUMMARY');
  console.log('========================================');
  Object.keys(boardCounts).sort().forEach(board => {
    console.log(`  ${board.padEnd(8)}: ${String(boardCounts[board]).padStart(4)} locations`);
  });
  console.log('----------------------------------------');
  console.log(`  TOTAL   : ${String(deduped.length).padStart(4)} entries`);
  console.log('========================================\n');

  // Write to schools.json in project root and Driving-Log/
  const jsonContent = JSON.stringify(deduped, null, 2);

  const targetPaths = [
    path.resolve(__dirname, '../schools.json'),
    path.resolve(__dirname, '../../schools.json')
  ];

  for (const targetPath of targetPaths) {
    try {
      fs.writeFileSync(targetPath, jsonContent, 'utf8');
      console.log(`✓ Written ${deduped.length} schools to: ${targetPath}`);
    } catch (e) {
      // Ignored if outside directory
    }
  }

  console.log('\nPipeline completed successfully!');
}

main().catch(err => {
  console.error('\nPipeline execution failed:', err);
  process.exit(1);
});
