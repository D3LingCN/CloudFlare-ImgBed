// R2保护扩展：systemd 夜间校对入口，仅读写统计库，不重置费用保护账本。
import { SqliteD1 } from './sqliteD1.js';
import { syncUsage } from '../../extensions/r2-usage/analytics.js';
const db=new SqliteD1(`${process.env.DATA_DIR||'/app/data'}/usage.sqlite`);
try {
    const result=await syncUsage({...process.env,R2_USAGE_DB:db},'server-scheduled');
    console.log(JSON.stringify(result));
    if(result.busy)process.exitCode=1;
} catch { console.error('Usage reconciliation failed; existing records retained');process.exitCode=1; }
finally{db.db.close();}
