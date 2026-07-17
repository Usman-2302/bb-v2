const axios = require('axios');
const { ema } = require('../indicators/ema');
const { atr } = require('../indicators/atr');
const { rvol } = require('../indicators/rvol');
const { cvd:cvdFn } = require('../indicators/cvd');
const RVOL=0.6, STOP=0.5, RR=2.0;

async function snapshot(){
  const resp=await axios.get('https://fapi.binance.com/fapi/v1/klines',{params:{symbol:'ETHUSDT',interval:'15m',limit:1500},timeout:15000});
  const raw=resp.data.map(k=>({openTime:k[0],closeTime:k[6],open:+k[1],high:+k[2],low:+k[3],close:+k[4],volume:+k[5]}));
  const candles=[];
  for(let i=0;i<Math.min(1000,raw.length);i++) candles.push(raw[i]);

  let ind;
  function ci(){ind={aArr:atr(candles,14),rArr:rvol(candles,'15m',20),cvArr:cvdFn(candles),eArr:ema(candles.map(x=>x.close),200)};}
  
  function dp(type){
    const pools=[],sw=[];
    for(let j=1;j<candles.length-1;j++){
      if(type==='LONG'&&candles[j].low<candles[j-1].low&&candles[j].low<candles[j+1].low)sw.push(j);
      if(type==='SHORT'&&candles[j].high>candles[j-1].high&&candles[j].high>candles[j+1].high)sw.push(j);
    }
    for(let a=0;a<sw.length;a++){for(let b=a+1;b<sw.length;b++){
      const si=sw[a],sj=sw[b];if(sj-si>80)break;if(sj-si<2)continue;
      const v1=type==='LONG'?candles[si].low:candles[si].high,v2=type==='LONG'?candles[sj].low:candles[sj].high;
      if(Math.abs(v1-v2)/v1>=0.005)continue;let swept=false;
      for(let k=si+1;k<sj;k++){const cv=type==='LONG'?candles[k].low:candles[k].high;if(type==='LONG'?cv<Math.min(v1,v2):cv>Math.max(v1,v2)){swept=true;break;}}
      if(swept)continue;pools.push({level:Math.floor((v1+v2)/2),formed:sj,expires:sj+500});
    }}
    return pools;
  }

  ci();
  let eq=90,t=0,w=0,l=0,lt=0,st=0,openTrade=null;
  let sweeps=0,ghosts=0,range=0,rskip=0;
  const entries=[];

  // Scan phase: indices 300-999
  for(let i=300;i<candles.length;i++){
    const c=candles[i];
    let regime='RANGING';
    if(i>=200){const pa=c.close>ind.eArr[i],s10=(ind.eArr[i]-ind.eArr[Math.max(0,i-10)])/ind.eArr[Math.max(0,i-10)];const ap=ind.aArr[i]/c.close*100;if(ap>5)regime='CRISIS';else if(s10>0.001&&pa)regime='BULL';else if(s10<-0.001&&!pa)regime='BEAR';}
    
    if(openTrade){let closed=false;if(openTrade.side==='LONG'){if(c.low<=openTrade.stop){eq-=openTrade.risk;l++;closed=true;}else if(c.high>=openTrade.tp){eq+=openTrade.risk*RR;w++;closed=true;}}else{if(c.high>=openTrade.stop){eq-=openTrade.risk;l++;closed=true;}else if(c.low<=openTrade.tp){eq+=openTrade.risk*RR;w++;closed=true;}}if(i-openTrade.idx>50){eq+=openTrade.risk*0.3;closed=true;}if(closed){t++;openTrade=null;}}
    if(openTrade)continue;
    if(regime==='RANGING'){range++;continue;}
    
    const rv=ind.rArr[i]||0,cvD=ind.cvArr.delta[i]||0,pvD=ind.cvArr.delta[i-1]||0,av=ind.aArr[i]||0;
    if(rv<RVOL){rskip++;continue;}
    
    const pools=dp(regime==='BULL'?'LONG':'SHORT');
    if(regime==='BULL'){for(const p of pools){if(p.formed>i||p.expires<i)continue;if(c.low>=p.level||c.close<=p.level)continue;sweeps++;if((cvD-pvD)<=0){ghosts++;continue;}const sd=av*STOP;if(sd<=0||p.level<=p.level-sd)continue;openTrade={side:'LONG',entry:p.level,stop:p.level-sd,tp:p.level+sd*RR,risk:eq*0.02,idx:i};lt++;entries.push({side:'L',entry:p.level,date:new Date(c.openTime).toISOString().slice(5,16)});break;}}
    else{for(const p of pools){if(p.formed>i||p.expires<i)continue;if(c.high<=p.level||c.close>=p.level)continue;sweeps++;if((cvD-pvD)>=0){ghosts++;continue;}const sd=av*STOP;if(sd<=0||p.level>=p.level+sd)continue;openTrade={side:'SHORT',entry:p.level,stop:p.level+sd,tp:p.level-sd*RR,risk:eq*0.02,idx:i};st++;entries.push({side:'S',entry:p.level,date:new Date(c.openTime).toISOString().slice(5,16)});break;}}
  }
  
  const preLive=t;
  // Live phase: indices 1000+
  const extra=raw.length-candles.length;
  for(let i=1000;i<raw.length;i++){
    candles.push(raw[i]);ci();
    const c=candles[i];
    let regime='RANGING';
    if(i>=200){const pa=c.close>ind.eArr[i],s10=(ind.eArr[i]-ind.eArr[Math.max(0,i-10)])/ind.eArr[Math.max(0,i-10)];const ap=ind.aArr[i]/c.close*100;if(ap>5)regime='CRISIS';else if(s10>0.001&&pa)regime='BULL';else if(s10<-0.001&&!pa)regime='BEAR';}
    
    if(openTrade){let closed=false;if(openTrade.side==='LONG'){if(c.low<=openTrade.stop){eq-=openTrade.risk;l++;closed=true;}else if(c.high>=openTrade.tp){eq+=openTrade.risk*RR;w++;closed=true;}}else{if(c.high>=openTrade.stop){eq-=openTrade.risk;l++;closed=true;}else if(c.low<=openTrade.tp){eq+=openTrade.risk*RR;w++;closed=true;}}if(i-openTrade.idx>50){eq+=openTrade.risk*0.3;closed=true;}if(closed){t++;openTrade=null;}}
    if(openTrade||regime==='RANGING')continue;
    
    const rv=ind.rArr[i]||0,cvD=ind.cvArr.delta[i]||0,pvD=ind.cvArr.delta[i-1]||0,av=ind.aArr[i]||0;
    if(rv<RVOL)continue;
    
    const pools=dp(regime==='BULL'?'LONG':'SHORT');
    if(regime==='BULL'){for(const p of pools){if(p.formed>i||p.expires<i)continue;if(c.low>=p.level||c.close<=p.level)continue;sweeps++;if((cvD-pvD)<=0){ghosts++;continue;}const sd=av*STOP;if(sd<=0||p.level<=p.level-sd)continue;openTrade={side:'LONG',entry:p.level,stop:p.level-sd,tp:p.level+sd*RR,risk:eq*0.02,idx:i};lt++;entries.push({side:'L',entry:p.level,date:new Date(c.openTime).toISOString().slice(5,16)});break;}}
    else{for(const p of pools){if(p.formed>i||p.expires<i)continue;if(c.high<=p.level||c.close>=p.level)continue;sweeps++;if((cvD-pvD)>=0){ghosts++;continue;}const sd=av*STOP;if(sd<=0||p.level>=p.level+sd)continue;openTrade={side:'SHORT',entry:p.level,stop:p.level+sd,tp:p.level-sd*RR,risk:eq*0.02,idx:i};st++;entries.push({side:'S',entry:p.level,date:new Date(c.openTime).toISOString().slice(5,16)});break;}}
  }

  const liveTrades=t-preLive;
  console.log('SCAN PHASE (300-999): '+preLive+' trades | WR '+(w/(t-liveTrades)*100).toFixed(0)+'%');
  console.log('LIVE PHASE (1000-'+candles.length+'): '+liveTrades+' trades');
  console.log('Sweeps:'+sweeps+' Ghosts:'+ghosts+' Range:'+range+' RVOLskip:'+rskip);
  console.log('Equity: $90 -> $'+eq.toFixed(2));
  
  // Post Jul 17 16:00 entries
  const recent=entries.filter(e=>e.date>='07-17T16:');
  console.log('Entries after Jul 17 16:00 UTC:',recent.length);
  if(recent.length===0){
    console.log('BOT IS CORRECT: No qualifiable sweeps exist in this window.');
    // Show last candles
    console.log('Last 10 candle RVOLs:');
    for(let i=raw.length-10;i<raw.length;i++){
      const c=raw[i],rv=ind.rArr[i]||0;
      let regime='RANGING';
      if(i>=200){const pa=c.close>ind.eArr[i],s10=(ind.eArr[i]-ind.eArr[Math.max(0,i-10)])/ind.eArr[Math.max(0,i-10)];const ap=ind.aArr[i]/c.close*100;if(ap>5)regime='CRISIS';else if(s10>0.001&&pa)regime='BULL';else if(s10<-0.001&&!pa)regime='BEAR';}
      console.log('  '+new Date(c.openTime).toISOString().slice(5,16)+' rv='+rv.toFixed(2)+' '+regime.padEnd(7)+' C='+c.close.toFixed(0));
    }
  }else{
    recent.forEach(e=>console.log('  '+e.side+' @ $'+e.entry+' '+e.date));
  }
}
snapshot().catch(e=>console.error(e.message));
