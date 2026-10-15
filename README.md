# CSV Dump Explorer

Local web app for exploring CSV "dumps" that contain several database tables back to back, where each table begins with its own header row.

Everything runs in your browser (a Web Worker parses the file). Nothing is uploaded.

## Run

```
npm install
npm run dev        # http://localhost:5178
```

`npm run sample` writes a synthetic 186k-row, 6-table dump to `sample-data/` (the empty screen has a button to load it). `npm test` runs the parser/segmentation tests. `npm run build` produces a static site in `dist/`.

## How tables are detected

A row is a candidate header when every non-empty cell is short, unique text (no numbers, dates or NULLs). Candidates are scored, and a score of 3 or more starts a new table:

| Signal | Points |
| --- | --- |
| Text where the current table has numeric/date columns | +3 (half or more of them), else +1 |
| Exactly repeats the current header | starts a table |
| Wider than the current header / narrower | +2 / +1 |
| Follows a blank line | +2 |
| Preceded by a one-cell row (used as the table's title) | +1 |
| Next row has numbers/dates under its labels | +1 |
| Values look like column names (`customer_id`, `createdAt`, …) | +1 |

Candidates scoring 1–2 are listed under **Possible headers not split**. In **Raw rows** you can split or merge at any line. Manual edits are saved in the browser per file, and the parser index can be exported as JSON or CSV and re-imported.

## Group by / counts

Pick one or more fields (e.g. `actor`, then `event_type`) to count every combination. Date fields can be bucketed by year, month or day. Optionally add a sum, average, min or max of another column.

## SQL Explorer

Every table is copied into an in-browser SQLite database (sql.js; still nothing is uploaded). Numbers are stored as REAL, dates as ISO text (`YYYY-MM-DD[ HH:MM:SS]`), and empty/NULL tokens as NULL. Every table also gets a `_line` column holding its source file line. Table and column names are lowercased, with spaces turned into `_` (`AUDIT LOG` → `audit_log`). SQL keywords get a suffix (`order` → `orders`).

- **Data model**: tables shown as cards. Drag a column onto a column in another table to create a relationship, choosing LEFT or INNER join. **Auto-detect** relates columns with matching names where one side is a unique key.
- **Query builder**: pick columns from any table, aggregate them (count, count distinct, sum, average, min, max), and bucket dates. Add WHERE filters, sorting and a limit. Tables are joined automatically along the shortest path of relationships, and the generated SQL is shown. **Edit as SQL** copies it to the editor.
- **SQL editor**: free-form SQLite. ⌘/Ctrl+Enter runs the query, or just the selected text. Includes example queries such as an orphan-row check.

Relationships, card layout and queries are saved in the browser per file.

Line numbers are physical file lines. Record numbers count CSV records, which differ when a quoted value contains newlines. The index reports both.
