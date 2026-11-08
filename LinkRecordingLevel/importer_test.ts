(globalThis as any).__ytmImporterTesting = true;
await import('./LinkRecordingLevel.user.js');
const api = (globalThis as any).__ytmImporter;
const id = 'e1720d01-e7ee-4984-a0d8-4459b6ea80ee';
const url = 'https://www.youtube.com/watch?v=abcdefghijk';
function equal(a: unknown, b: unknown) { if (JSON.stringify(a) !== JSON.stringify(b)) throw Error(`${JSON.stringify(a)} != ${JSON.stringify(b)}`); }
function rejects(fn: () => unknown) { let failed = false; try { fn(); } catch { failed = true; } if (!failed) throw Error('Expected rejection'); }
Deno.test('release identifiers and watch URLs are validated and canonicalized', () => {
  equal(api.releaseId(`https://musicbrainz.org/release/${id}`), id);
  rejects(() => api.releaseId(`https://evil.test/release/${id}`));
  rejects(() => api.releaseId(`https://musicbrainz.org/recording/${id}`));
  equal(api.trackUrl('/watch?v=abcdefghijk&list=album'), url);
  equal(api.trackUrl('https://evil.test/watch?v=abcdefghijk'), null);
  equal(api.trackUrl('/playlist?list=album'), null);
});
Deno.test('release disc order and duplicate recording mappings remain explicit', () => {
  const tracks = api.releaseTracks({ media: [{ position: 1, tracks: [{ position: 1, title: 'First', recording: { id } }] }, { position: 2, tracks: [{ position: 1, title: 'Again', recording: { id } }] }] });
  equal(tracks.map((t: any) => t.position), ['1.1', '2.1']);
  equal(api.jobsFor([{ url }, { url }], tracks, [0, 1]).length, 1);
  rejects(() => api.jobsFor([{ url }, { url: url.replace('abcdefghijk', 'zyxwvutsrqp') }], tracks, [0, 1]));
  rejects(() => api.jobsFor([{ url: null }], tracks, [0]));
  equal(api.jobsFor([{ url }, { url: null }], tracks, [0, -1]).length, 1);
});
Deno.test('recording editor seeds free streaming without comments or video attribute', () => {
  const edit = new URL(api.editUrl({ id, title: 'Song & mix', url }, 'https://music.youtube.com/playlist?list=album', 'batch'));
  equal(edit.pathname, `/recording/${id}/edit`);
  equal(edit.searchParams.get('edit-recording.url.0.text'), url);
  equal(edit.searchParams.get('edit-recording.url.0.link_type_id'), '268');
  equal(edit.searchParams.has('edit-recording.edit_note'), false);
  equal(edit.hash, '#ytm-import=batch');
});

Deno.test('YouTube variants normalize to regular YouTube without playlist parameters', () => {
  for (const raw of ['https://music.youtube.com/watch?v=abcdefghijk&list=album', 'https://youtube.com/watch?v=abcdefghijk&index=2', 'https://youtu.be/abcdefghijk']) equal(api.trackUrl(raw), url);
});
Deno.test('existing URLs are skipped regardless of relationship type or ended status', () => {
  const job = { links: [{url}, {url:'https://www.youtube.com/watch?v=zyxwvutsrqp'}] };
  const relation = {'target-type':'url', 'type-id':'7e41ef12-a124-4324-afdb-fdbae687a89c',url:{resource:url.replace('www.', 'music.')}};
  equal(api.missingLinks(job,{relations:[relation]}).length,1);
  equal(api.missingLinks(job,{relations:[{...relation,ended:true}]}).length,1);
  equal(api.missingLinks(job,{relations:[{...relation,'type-id':'other'}]}).length,1);
});

Deno.test('all existing YouTube variants skip while a different video remains importable', () => {
  for (const resource of [url, 'https://music.youtube.com/watch?v=abcdefghijk&list=album', 'https://youtu.be/abcdefghijk']) {
    equal(api.missingLinks({url},{relations:[{'target-type':'url',url:{resource}}]}), []);
  }
  equal(api.missingLinks({url},{relations:[{'target-type':'url',url:{resource:'https://www.youtube.com/watch?v=zyxwvutsrqp'}}]}).length, 1);
});
Deno.test('release playlists normalize separately from individual watch URLs', () => {
 equal(api.playlistUrl('https://music.youtube.com/watch?v=abcdefghijk&list=OLAK5uy_test&index=2'), 'https://www.youtube.com/playlist?list=OLAK5uy_test');
 equal(api.playlistUrl(url), null);
 equal(api.playlistUrl('https://evil.test/playlist?list=PL123'), null);
});
Deno.test('release streaming offers deduplicate YouTube variants and exclude ended or non-stream links', () => {
 const relation=(resource:string,type='streaming',ended=false)=>({'target-type':'url',type,ended,url:{resource}});
 const choices=api.streamingSources({relations:[relation('https://music.youtube.com/playlist?list=PL123'),relation('https://www.youtube.com/playlist?list=PL123'),relation('https://open.spotify.com/album/1234567890123456789012'),relation('https://example.com','discography'),relation('https://www.youtube.com/playlist?list=PL456','streaming',true)]});
 equal(choices.length,2); equal(choices[0].supported,true); equal(choices[1].supported,true);
});
Deno.test('additional providers retain track identity and relationship type', () => {
 const spotify=api.canonicalTrackLink('https://open.spotify.com/track/1GJPddM9mYZs6IwVfBfXAX?si=tracking');
 equal(spotify.type,'268');equal(spotify.url,'https://open.spotify.com/track/1GJPddM9mYZs6IwVfBfXAX');
 const soundcloud=api.canonicalTrackLink('https://soundcloud.com/artist/song?in=artist/sets/album');
 equal(soundcloud.type,'268');equal(soundcloud.url,'https://soundcloud.com/artist/song');
 equal(api.collectionUrl('https://soundcloud.com/artist/sets/album?si=tracking'),'https://soundcloud.com/artist/sets/album');
 equal(api.canonicalTrackLink('https://soundcloud.com/artist/sets/album'),null);
});
Deno.test('merge providers once per recording then skip individual existing URLs',()=>{
 const youtube={url},spotify={url:'https://open.spotify.com/track/1GJPddM9mYZs6IwVfBfXAX'},soundcloud={url:'https://soundcloud.com/artist/song'};
 const jobs=api.mergeJobs([[{id,links:[youtube]}],[{id,links:[spotify,youtube]}],[{id,links:[soundcloud]}]]);
 equal(jobs.length,1);equal(jobs[0].links.length,3);
 const relations=[{'target-type':'url',url:{resource:url.replace('www.','music.')}}];
 equal(api.missingLinks(jobs[0],{relations}).map((link:any)=>link.service),['Spotify','SoundCloud']);
 equal(api.missingLinks(jobs[0],{relations:jobs[0].links.map((link:any)=>({'target-type':'url',url:{resource:link.url}}))}),[]);
});
Deno.test('selected sources collect concurrently without mixing responses and clean up tabs', async()=>{
 const values=new Map<string,any>(),listeners=new Map<string,any>(),opened:string[]=[],options:any[]=[];let closed=0;
 const globals=globalThis as any;
 globals.GM_setValue=(key:string,value:any)=>{values.set(key,value)};
 globals.GM_addValueChangeListener=(key:string,fn:any)=>{listeners.set(key,fn);return key};
 globals.GM_removeValueChangeListener=(key:string)=>{listeners.delete(key)};
 globals.GM_openInTab=(url:string,settings:any)=>{opened.push(url);options.push(settings);return {close:()=>closed++}};
 const controller=new AbortController();
 const one=api.collectSource({url:'https://www.youtube.com/playlist?list=PL123'},controller.signal);
 const two=api.collectSource({url:'https://open.spotify.com/album/57TzZhbqvYoUBzJSVKFVlG'},controller.signal);
 for(let i=0;i<8;i++)await Promise.resolve();
 equal(opened.length,2);equal(options.map(x=>x.active),[false,true]);
 const keys=[...listeners.keys()];
 listeners.get(keys[1])(keys[1],null,{rows:[{title:'second'}]});
 listeners.get(keys[0])(keys[0],null,{rows:[{title:'first'}]});
 equal(await one,[{title:'first'}]);equal(await two,[{title:'second'}]);
 equal(closed,2);equal(listeners.size,0);
 const aborted=api.collectSource({url:'https://www.youtube.com/playlist?list=PL456'},controller.signal);
 await Promise.resolve();controller.abort();
 let rejected=false;try{await aborted}catch{rejected=true}equal(rejected,true);equal(listeners.size,0);equal(closed,3);
});
Deno.test('stale, completed and malformed batches cannot block a new import',()=>{
 const now=10000000, batch={batchId:'saved',created:now-1000,index:0,jobs:[{id}]};
 equal(api.unfinishedBatch(batch,now),true);
 for(const bad of [null,{}, {...batch,created:now-3600000},{...batch,created:now+1},{...batch,index:1},{...batch,index:-1},{...batch,jobs:null},{...batch,created:undefined}]) equal(api.unfinishedBatch(bad,now),false);
});
Deno.test('an old editor cannot cancel a newer batch',async()=>{
 let state:any={batchId:'new'};
 (globalThis as any).GM_getValue=()=>state;
 (globalThis as any).GM_setValue=(_key:string,value:any)=>{state=value};
 equal(await api.cancelBatch('old'),false);equal(state.batchId,'new');
 equal(await api.cancelBatch('new'),true);equal(state,null);
});
Deno.test('barcode search preserves leading zeroes and only offers missing YouTube albums',()=>{
 equal(api.barcodeSearchUrl({barcode:'0012345678901'}),'https://music.youtube.com/search?q=%220012345678901%22');
 equal(api.barcodeSearchUrl({barcode:''}),null);equal(api.barcodeSearchUrl({barcode:'none'}),null);
 equal(api.hasYouTubeAlbum({relations:[{url:{resource:'https://music.youtube.com/playlist?list=OLAK123'}}]}),true);
 equal(api.hasYouTubeAlbum({relations:[{url:{resource:'https://music.youtube.com/browse/MPRE123'}}]}),true);
 equal(api.hasYouTubeAlbum({relations:[{url:{resource:'https://www.youtube.com/watch?v=abcdefghijk'}}]}),false);
});
Deno.test('general release URLs and native release submission validation',()=>{
 equal(api.releaseUrl('https://example.com/release/123'),'https://example.com/release/123');
 equal(api.releaseUrl('javascript:alert(1)'),null);
 equal(api.releaseUrl('https://music.youtube.com/playlist?list=PL123'),'https://www.youtube.com/playlist?list=PL123');
 const url='https://example.com/release/123';
 const tree={iterate:(value:any)=>value};
 const editor={externalLinksData:()=>[{url,relationships:[{linkTypeID:85}]}],allEdits:()=>[{}],allowsSubmission:()=>true};
 equal(api.verifiedReleaseEdit(editor,tree,url),true);
 equal(api.verifiedReleaseEdit({...editor,allowsSubmission:()=>false},tree,url),false);
 equal(api.verifiedReleaseEdit({...editor,allEdits:()=>[{},{}]},tree,url),false);
 equal(api.verifiedReleaseEdit(editor,tree,'https://example.com/other'),false);
 equal(api.verifiedReleaseEdit({...editor,externalLinksData:()=>[{url,relationships:[{linkTypeID:null}]}]},tree,url),false);
});


Deno.test('Spotify queue advances on closure and supports manual activation and cancellation', async()=>{
 const g=globalThis as any,listeners=new Map<string,any>(),opened:any[]=[];
 g.GM_setValue=()=>{};g.GM_addValueChangeListener=(key:string,fn:any)=>{listeners.set(key,fn);return key};
 g.GM_removeValueChangeListener=(key:string)=>listeners.delete(key);
 g.GM_openInTab=(_url:string,options:any)=>{const tab={options,close(){},onclose:()=>{}};opened.push(tab);return tab};
 const c=new AbortController(),cancelled=new AbortController(),choice={url:'https://open.spotify.com/album/7CItFSiq0XApf0ZjBuo7fL'};
 const one=api.collectSource(choice,c.signal).then(()=>false,()=>true);
 const two=api.collectSource(choice,c.signal,{activateSpotify:false});
 const three=api.collectSource(choice,cancelled.signal).then(()=>false,()=>true);
 const flush=async()=>{for(let i=0;i<15;i++)await Promise.resolve()};
 await flush();equal(opened.length,1);equal(opened[0].options.active,true);
 cancelled.abort();opened[0].onclose();equal(await one,true);
 await flush();equal(opened.length,2);equal(opened[1].options.active,false);
 const key=[...listeners.keys()][0];listeners.get(key)(key,null,{rows:[{title:'done'}]});
 equal(await two,[{title:'done'}]);equal(await three,true);equal(opened.length,2);equal(listeners.size,0);
});

Deno.test('concurrent import batches keep independent progress and cancellation',async()=>{
 const values=new Map<string,any>();
 const g=globalThis as any;
 g.GM_getValue=(key:string,fallback:any=null)=>values.get(key)??fallback;
 g.GM_setValue=(key:string,value:any)=>{values.set(key,value)};
 const first={batchId:'release-one',created:Date.now(),jobs:[{id}],index:0,progress:'Opening'};
 const second={batchId:'release-two',created:Date.now(),jobs:[{id}],index:0,progress:'Opening'};
 await Promise.all([api.saveBatch(first),api.saveBatch(second)]);
 await api.saveBatch({...first,progress:'Saving 1/1'});
 equal((await api.readBatch(first.batchId)).progress,'Saving 1/1');
 equal((await api.readBatch(second.batchId)).progress,'Opening');
 equal(await api.cancelBatch(first.batchId),true);
 equal(await api.readBatch(first.batchId),null);
 equal((await api.readBatch(second.batchId)).batchId,second.batchId);
});

Deno.test('resume discovers old batches only for this release and reconciles a completed save',async()=>{
 const g=globalThis as any, values=new Map<string,any>(), key='release-stream-import-v3:batch:resume';
 const batch={batchId:'resume',release:id,source:`https://musicbrainz.org/release/${id}`,created:Date.now()-86400000,jobs:[{id,url}],index:0,submitted:true,runId:'old'};
 values.set(key,batch); values.set(key+'-other',{...batch,batchId:'other',release:'other'});
 g.GM_listValues=()=>[...values.keys()];g.GM_getValue=(key:string,fallback:any=null)=>values.get(key)??fallback;g.GM_setValue=(key:string,value:any)=>values.set(key,value);
 g.GM_xmlhttpRequest=(request:any)=>request.onload({status:200,responseText:JSON.stringify({id,relations:[{'target-type':'url',url:{resource:url}}]})});
 equal((await api.resumableBatches(id)).map((batch:any)=>batch.batchId),['resume']);
 let approvals=0;
 const next=await api.prepareResume('resume',()=>{approvals++;return false});
 equal(next.index,1);equal(next.progress,'Complete');equal(next.submitted,false);equal(approvals,0);equal(next.runId==='old',false);
 equal(await api.resumableBatches(id),[]);
});
Deno.test('resume preserves uncertain submissions unless retry is explicitly confirmed',async()=>{
 const g=globalThis as any, values=new Map<string,any>(), key='release-stream-import-v3:batch:resume';
 values.set(key,{batchId:'resume',release:id,created:Date.now(),jobs:[{id,url}],index:0,submitted:true});
 g.GM_getValue=(key:string,fallback:any=null)=>values.get(key)??fallback;g.GM_setValue=(key:string,value:any)=>values.set(key,value);
 g.GM_xmlhttpRequest=(request:any)=>request.onload({status:200,responseText:JSON.stringify({id,relations:[]})});
 let rejected=false;try{await api.prepareResume('resume',()=>false)}catch{rejected=true}
 equal(rejected,true);equal(values.get(key).submitted,true);equal(values.get(key).index,0);
 const next=await api.prepareResume('resume',()=>true);equal(next.submitted,false);equal(next.index,0);
 equal(api.editUrl(next.jobs[0],'','resume',next.runId).endsWith(`&run=${next.runId}`),true);
});
Deno.test('resume failed lookup retains the pending recording for another attempt',async()=>{
 const g=globalThis as any, values=new Map<string,any>(), key='release-stream-import-v3:batch:resume';
 values.set(key,{batchId:'resume',release:id,created:Date.now(),jobs:[{id,url}],index:0,submitted:true});
 g.GM_getValue=(key:string,fallback:any=null)=>values.get(key)??fallback;g.GM_setValue=(key:string,value:any)=>values.set(key,value);
 g.GM_xmlhttpRequest=(request:any)=>request.onerror();
 let rejected=false;try{await api.prepareResume('resume',()=>true)}catch{rejected=true}
 equal(rejected,true);equal(values.get(key).submitted,true);equal(values.get(key).index,0);
});

Deno.test('Spotify and SoundCloud serialize in either order, including failure and delayed cleanup',async()=>{
 const providers=['https://open.spotify.com/album/57TzZhbqvYoUBzJSVKFVlG','https://soundcloud.com/artist/sets/album'];
 for(const order of [providers,[...providers].reverse()])for(const failFirst of [false,true]){
  const g=globalThis as any,listeners=new Map<string,any>(),opened:any[]=[];
  let releaseCleanup!:()=>void;
  const cleanup=new Promise<void>(resolve=>{releaseCleanup=resolve});
  g.GM_setValue=async(_key:string,value:any)=>{if(value===null && opened.length===1)await cleanup};
  g.GM_addValueChangeListener=(key:string,fn:any)=>{listeners.set(key,fn);return key};
  g.GM_removeValueChangeListener=(key:string)=>listeners.delete(key);
  g.GM_openInTab=(url:string,options:any)=>{const tab={url,options,closed:false,close(){this.closed=true}};opened.push(tab);return tab};
  const signal=new AbortController().signal;
  const first=api.collectSource({url:order[0]},signal).then((rows:any)=>rows,()=> 'failed');
  const second=api.collectSource({url:order[1]},signal);
  const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve()};
  await flush();equal(opened.length,1);equal(opened[0].options.active,true);equal(opened[0].url.startsWith(order[0]),true);
  const firstKey=[...listeners.keys()][0];
  listeners.get(firstKey)(firstKey,null,failFirst?{error:'Unavailable'}:{rows:[{title:'first'}]});
  await flush();equal(opened[0].closed,true);equal(opened.length,1);
  releaseCleanup();equal(await first,failFirst?'failed':[{title:'first'}]);await flush();
  equal(opened.length,2);equal(opened[1].options.active,true);equal(opened[1].url.startsWith(order[1]),true);
  const secondKey=[...listeners.keys()][0];listeners.get(secondKey)(secondKey,null,{rows:[{title:'second'}]});
  equal(await second,[{title:'second'}]);equal(opened[1].closed,true);equal(listeners.size,0);
 }
});
