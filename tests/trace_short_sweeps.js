'use strict';
const fs=require('fs');const path=require('path');const readline=require('readline');const {createReadStream}=require('fs');
async function load(f){const c=[];const rl=readline.createInterface({input:createReadStream(f),crlfDelay:Infinity});for await(const l of rl){if(l.trim())c.push(JSON.parse(l))}return c}
async function main(){
const {atr}=require('../src/indicators/atr');
const {isBearishSweep,buildBearishLSOSignal}=require('../src/strategies/lso');
const {findDOL}=require('../src/utils/dolFinder');
const {simulateLimitFill}=require('../src/backtest/engine');
const {DATA:{paths},LSO:cfg}=require('../config');
const all=await load(path.join(paths.historical,'BTCUSDT_15m_tagged.ndjson'));
const a=atr(all,14);
const sh=[];for(let i=1;i<all.length-1;i++)if(all[i].high>all[i-1].high&&all[i].high>all[i+1].high)sh.push(i);
let found=0;
for(let ai=0;ai<sh.length&&found<10;ai++){
for(let b=ai+1;b<sh.length&&found<10;b++){
const si=sh[ai],sj=sh[b];
if(sj-si>cfg.equalLookback)break;
if(sj-si<cfg.equalMinGap)continue;
if(Math.abs(all[si].high-all[sj].high)/all[si].high>=cfg.equalTolerance)continue;
let swp=false;
for(let k=si+1;k<sj;k++)if(all[k].high>Math.max(all[si].high,all[sj].high)){swp=true;break}
if(swp)continue;
const pool={type:'EQUAL_HIGHS',level:(all[si].high+all[sj].high)/2};
for(let i=sj;i<=Math.min(sj+cfg.equalLookback,all.length-1);i++){
if(isBearishSweep(all[i],pool)){
found++;
console.log('Sweep #'+found+': candle='+i+' level='+pool.level.toFixed(2)+' high='+all[i].high+' close='+all[i].close+' regime='+all[i].regime+' time='+new Date(all[i].openTime).toISOString());
const sig=buildBearishLSOSignal(all[i],pool,a[i]||0);
console.log('  limitPrice='+sig.limitPrice?.toFixed(2)+' stopPrice='+sig.stopPrice?.toFixed(2));
const dol=findDOL(all,i,sig.limitPrice,sig.stopPrice,'SHORT',[],a);
console.log('  DOL:',dol?'found(tier='+dol.tier+',dol='+dol.dol?.toFixed(2)+')':'NOT FOUND');
if(dol){const fill=simulateLimitFill(all[i],{side:'SHORT',limitPrice:sig.limitPrice},'LSO','BTCUSDT',a[i]);console.log('  Fill:',fill.fill?'YES('+fill.quality+')':'NO('+fill.quality+')')}
break;
}
}
}
}
console.log('Total sweeps found (all regimes):',found);
}
main().catch(e=>{console.error(e);process.exit(1)});
