import fs from 'node:fs';
import { resolve } from 'node:path';
import { SqliteD1 } from './sqliteD1.js';
const [input,output]=process.argv.slice(2);
if(!input||!output)throw new Error('Usage: importSnapshot.mjs snapshot.json new.sqlite');
if(fs.existsSync(output))throw new Error('Refusing to overwrite an existing database');
const snapshot=JSON.parse(fs.readFileSync(input,'utf8'));
const tables=snapshot.schema.filter(x=>x.type==='table');
if(!tables.length || tables.some(t=>!Array.isArray(snapshot.rows[t.name])))throw new Error('Incomplete snapshot');
const db=new SqliteD1(resolve(output));
db.db.transaction(()=>{
    for(const t of tables)db.exec(t.sql);
    for(const t of tables){
        for(const row of snapshot.rows[t.name]){
            const cols=Object.keys(row);
            if(cols.some(c=>!/^[a-z_][a-z0-9_]*$/i.test(c)))throw new Error('Invalid column');
            const query=`INSERT INTO "${t.name}" (${cols.map(c=>`"${c}"`).join(',')}) VALUES(${cols.map(()=>'?').join(',')})`;
            db.db.prepare(query).run(...cols.map(c=>row[c]));
        }
    }
    for(const item of snapshot.schema.filter(x=>x.type!=='table'))db.exec(item.sql);
})();
for(const t of tables){
    const actual=db.db.prepare(`SELECT COUNT(*) AS n FROM "${t.name}"`).get().n;
    if(actual!==snapshot.rows[t.name].length)throw new Error('Imported row count mismatch');
    console.log(`${t.name}: ${actual} rows verified`);
}
const integrity=db.db.pragma('integrity_check',{simple:true});
if(integrity!=='ok')throw new Error('Database integrity check failed');
db.db.close();console.log('Import verified; original snapshot retained');
