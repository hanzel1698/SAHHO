import json, csv, pathlib, collections, datetime
import openpyxl
root = pathlib.Path(__file__).resolve().parents[1]
out = root / '.private'
out.mkdir(exist_ok=True)
import sys, os
# Usage: python scripts/inspect_sources.py <workbook.xlsx>   (writes .private/workbook-inspection.json)
if len(sys.argv) < 2 and not os.environ.get('SAHHO_WORKBOOK'):
    sys.exit('Usage: python scripts/inspect_sources.py <workbook.xlsx>')
path = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else os.environ['SAHHO_WORKBOOK'])
w = openpyxl.load_workbook(path, data_only=False)
v = openpyxl.load_workbook(path, data_only=True)
report = []
for s in w:
    rows=[]; count=0; formulas=0; comments=0
    grouped=collections.defaultdict(list)
    for c in s._cells.values():
        if c.value is not None or c.comment: grouped[c.row].append(c)
    for row in [sorted(grouped[k],key=lambda c:c.column) for k in sorted(grouped)]:
        cells={c.coordinate: {'value':c.value, 'cached':v[s.title][c.coordinate].value, 'note':c.comment.text if c.comment else None} for c in row if c.value is not None or c.comment}
        if cells:
            rows.append(cells); count+=len(cells)
            formulas+=sum(c.data_type=='f' for c in row)
            comments+=sum(bool(c.comment) for c in row)
    report.append({'sheet':s.title, 'dimension':s.calculate_dimension(), 'populatedRows':len(rows),'cells':count,'formulas':formulas,'comments':comments,'rows':rows})
(out/'workbook-inspection.json').write_text(json.dumps(report,default=str,ensure_ascii=False,indent=2),encoding='utf8')
for s in report:
    print(json.dumps({k:v for k,v in s.items() if k!='rows'}))
    for row in s['rows'][:5]:
        print(json.dumps(row,default=str,ensure_ascii=True))
