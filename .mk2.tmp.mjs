import ExcelJS from 'exceljs';
const S='/tmp/claude-0/-home-user-shop-intoto/c8d8d7a8-706d-5479-a974-7bf55eb691c3/scratchpad/';
const full = ['Ser.','IWS Number','Priority','Area','Unit ','Discipline','Description','Date Issued','Target Date','Counter','Notification No.','WO. No.','PR & PO No','Items Count','Items Comp.','Progress','Type Of Inspection','Action By','Updates','Status','Close Date','Remarks'];
const misspelled = full.map(h => h === 'Target Date' ? 'Targate Date' : h);
const missing = full.filter(h => h !== 'Target Date');

const wb = new ExcelJS.Workbook();
const add = (name, headers, count, prefix) => {
  const ws = wb.addWorksheet(name);
  ws.getRow(1).values = [name];
  ws.getRow(2).values = headers;
  for (let i=1;i<=count;i++) {
    const row = [i, `IWS-${prefix}-${i}`, 'P3', 'SHP', '178', 'Mechanical', `Job ${i}`, '2026-01-01'];
    if (headers.includes('Target Date') || headers.includes('Targate Date')) row.push('2027-06-30');
    ws.getRow(2+i).values = row;
  }
};
add('SHU-Master Tracking Sheet', full, 3, 'SHU');
add('Misspelt Target', misspelled, 3, 'MIS');
add('DCU-Master Tracking Sheet', missing, 3, 'DCU');
await wb.xlsx.writeFile(S + 'target-date-cases.xlsx');

const X = await import('./apps/tracker/src/excel.js');
const { readFile } = await import('node:fs/promises');
const { sheets } = await X.inspectWorkbook(await readFile(S + 'target-date-cases.xlsx'));
for (const s of sheets) {
  console.log(`${s.name.padEnd(28)} rows=${s.dataRows}  hasTargetDate=${s.mappedColumns.some(c=>c.field==='targetDate')}  missing=${JSON.stringify((s.missingKeyColumns??[]).map(m=>m.label))}`);
}
