// Live Spotify integration check. GM tab/storage APIs are bridged to Playwright;
// this exercises real provider tabs but does not emulate Violentmonkey installation.
import { chromium, type Page } from 'npm:playwright@^1.46.0';
const script = await Deno.readTextFile(new URL('./LinkRecordingLevel.user.js', import.meta.url));
const browser = await chromium.launch({headless: !Deno.args.includes('--headed')});
try {
 const context = await browser.newContext();
 const parent = await context.newPage();
 await parent.route('https://musicbrainz.org/release/test',route=>route.fulfill({body:'<p>Importer test</p>',contentType:'text/html'}));
 await parent.goto('https://musicbrainz.org/release/test');
 const values = new Map<string, unknown>(), tabs = new Map<string, Promise<Page>>();
 let concurrent = 0, peak = 0;
 await parent.exposeFunction('__store', async (key:string,value:unknown)=>{values.set(key,value)});
 await parent.exposeFunction('__open', (id:string,url:string,options:{active:boolean,insert:boolean})=>{
  if(!options.active || !options.insert)throw Error('Spotify source collection needs its tab active');
  const pending=(async()=>{
   concurrent++;peak=Math.max(peak,concurrent);
   const page=await context.newPage();
   await page.exposeFunction('GM_getValue',(key:string,fallback:unknown)=>values.get(key)??fallback);
   await page.exposeFunction('GM_setValue',async(key:string,value:unknown)=>{
    values.set(key,value);
    await parent.evaluate(({key,value})=>{(globalThis as any).__listeners.get(key)?.(key,null,value)}, {key,value});
   });
   await page.addInitScript('globalThis.__ytmImporterTesting=true');
   await page.goto(url,{waitUntil:'domcontentloaded'});
   await page.bringToFront();
   await page.evaluate(script);
   await page.evaluate(token=>(globalThis as any).__ytmImporter.sourceWorker(token),new URL(url).hash.slice('#mb-source='.length));
   return page;
  })();
  tabs.set(id,pending);
 });
 await parent.exposeFunction('__close',async(id:string)=>{
  const pending=tabs.get(id);if(!pending)return;
  tabs.delete(id);const page=await pending;await page.close();concurrent--;await parent.bringToFront();
 });
 await parent.evaluate(()=>{
  const g=globalThis as any;g.__ytmImporterTesting=true;g.__listeners=new Map();
  g.GM_setValue=g.__store;
  g.GM_addValueChangeListener=(key:string,fn:any)=>{g.__listeners.set(key,fn);return key};
  g.GM_removeValueChangeListener=(key:string)=>g.__listeners.delete(key);
  g.GM_openInTab=(url:string,options:any)=>{const id=crypto.randomUUID();g.__open(id,url,options);return {close:()=>g.__close(id)}};
 });
 await parent.evaluate(script);
 const results=await parent.evaluate(async()=>{
  const g=globalThis as any,c=new AbortController();
  return await Promise.all(['7CItFSiq0XApf0ZjBuo7fL','57TzZhbqvYoUBzJSVKFVlG'].map(async id=>{
   const rows=await g.__ytmImporter.collectSource({url:`https://open.spotify.com/album/${id}`},c.signal);
   return {id,count:rows.length,playable:rows.filter((r:any)=>r.url).length,first:rows[0]?.title,last:rows.at(-1)?.title};
  }));
 });
 if(results[0].count!==36 || results[1].count!==34 || results.some(r=>r.count!==r.playable))throw Error(JSON.stringify(results));
 console.log(JSON.stringify({results,peak},null,2));
} finally {await browser.close()}
