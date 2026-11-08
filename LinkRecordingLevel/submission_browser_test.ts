import { chromium } from 'npm:playwright@^1.46.0';
const browser = await chromium.launch({headless:true});
const page = await browser.newPage();
await page.setContent(`<form class="edit-recording"><table><tr class="external-link-item"><td><a class="url" href="https://music.youtube.com/watch?v=abcdefghijk">URL</a></td></tr></table><button class="submit" type="submit">Enter edit</button></form>`);
await page.evaluate(() => { (globalThis as any).__ytmImporterTesting = true; });
await page.addScriptTag({content: await Deno.readTextFile(new URL('./LinkRecordingLevel.user.js', import.meta.url))});
const result = await page.evaluate(() => {
 const api = (globalThis as any).__ytmImporter;
 const job = {url:'https://music.youtube.com/watch?v=abcdefghijk'};
 const seeded = api.seededForm(document,job);
 if (!seeded) throw Error('Visible React link not recognized');
 if (api.submitVerified(seeded,job)) throw Error('Unserialized edit accepted');
 let type = '268';
 document.addEventListener('submit', (event) => {
  if (event.target !== seeded.form) return;
  seeded.form.querySelectorAll('input').forEach((x: Element)=>x.remove());
  for(const [name,value] of [['text',job.url],['link_type_id',type]]) {
   const input=document.createElement('input'); input.type='hidden'; input.name=`edit-recording.url.0.${name}`; input.value=value; seeded.form.append(input);
  }
 });
 // Prevent actual navigation after the importer validates the event.
 const original=seeded.form.requestSubmit.bind(seeded.form);
 seeded.form.requestSubmit=(button: HTMLButtonElement)=>{
  const prevent=(e: Event)=>e.preventDefault();
  window.addEventListener('submit',prevent,{once:true}); original(button);
 };
 if (!api.submitVerified(seeded,job)) throw Error('Correct serialized edit rejected');
 type='999';
 if (api.submitVerified(seeded,job)) throw Error('Wrong relationship accepted');
 return 'PASS: React serialization timing, valid submit, missing fields and wrong type';
});
console.log(result);
await page.setContent(`<ytd-playlist-video-list-renderer style="display:block"><ytd-playlist-video-renderer><a id="video-title" href="/watch?v=abcdefghijk&list=album">First</a></ytd-playlist-video-renderer><ytd-playlist-video-renderer><span id="video-title">Unavailable</span></ytd-playlist-video-renderer><ytd-playlist-video-renderer><a id="video-title" href="/watch?v=zyxwvutsrqp&index=3">Third</a></ytd-playlist-video-renderer></ytd-playlist-video-list-renderer>`);
await page.evaluate(() => {
 const rows = (globalThis as any).__ytmImporter.collect(document);
 if (rows.length !== 3 || rows[1].url !== null || rows[2].url !== 'https://www.youtube.com/watch?v=zyxwvutsrqp') throw Error('Playlist order/normalization failed');
});
console.log('PASS: regular playlist order, unavailable slot and canonical URLs');
await page.setContent('<div id="choices"></div>');
await page.evaluate(() => {
 const api=(globalThis as any).__ytmImporter;
 const chosen=api.providerCheckboxes(document.querySelector('#choices'),[
  {url:'https://www.youtube.com/playlist?list=PL123',label:'www.youtube.com',supported:true},
  {url:'https://open.spotify.com/album/1234567890123456789012',label:'open.spotify.com',supported:true},
  {url:'https://example.com/album',label:'example.com',supported:false},
 ]);
 const checks=[...document.querySelectorAll('input')] as HTMLInputElement[];
 if(chosen().length!==2 || checks.length!==2) throw Error('Only supported providers should be displayed');
 checks[0].checked=true; checks[1].checked=false;
 if(chosen().length!==1 || !chosen()[0].url.includes('youtube')) throw Error('Provider selection ignored');
 checks[1].checked=true; checks[0].checked=false;
 if(chosen().length!==1 || chosen()[0].label!=='open.spotify.com') throw Error('Unchecked provider included');
});
console.log('PASS: provider picker shows supported choices only');
await page.setContent(`<main><div role="grid"><div data-testid="tracklist-row"><a href="/track/1GJPddM9mYZs6IwVfBfXAX">Spotify song</a></div><div data-testid="tracklist-row"><span data-testid="track-name">Unavailable</span></div></div></main>`);
await page.evaluate(()=>{
 const rows=(globalThis as any).__ytmImporter.collectProvider(document,'https://open.spotify.com/album/1234567890123456789012');
 if(rows.length!==2 || rows[1].url!==null || rows[0].title!=='Spotify song')throw Error('Spotify track slots lost');
});
await page.setContent(`<main><ul class="trackList"><li class="trackList__item"><a href="/artist">Artist</a><a class="trackItem__trackTitle" href="/artist/song?in=artist/sets/album">SoundCloud song</a></li></ul><aside><a href="/artist/recommended">Recommendation</a></aside></main>`);
await page.evaluate(()=>{
 const rows=(globalThis as any).__ytmImporter.collectProvider(document,'https://soundcloud.com/artist/sets/album');
 if(rows.length!==1 || rows[0].url!=='https://soundcloud.com/artist/song')throw Error('SoundCloud scope wrong');
});
await page.setContent(`<main><ul class="trackList"><li class="trackList__item" aria-posinset="2"><a href="https://soundcloud.com/artist/two">Two</a></li></ul></main><script>window.__sc_hydration = [{"hydratable":"playlist","data":{"permalink_url":"https://soundcloud.com/artist/sets/album","track_count":3,"tracks":[{"title":"One","permalink_url":"https://soundcloud.com/artist/one"},{"id":2},{"id":3}]}}];</script>`);
await page.evaluate(()=>{
 const api=(globalThis as any).__ytmImporter, collected=new Map(),source='https://soundcloud.com/artist/sets/album';
 let snapshot=api.soundcloudSnapshot(document,source,collected);
 if(snapshot.complete || collected.size!==2)throw Error('Partial SoundCloud list accepted or hydrated track missed');
 document.querySelector('.trackList')!.innerHTML='<li class="trackList__item"><span class="trackItem__number">3.</span><a href="https://soundcloud.com/artist/three">Three</a></li>';
 snapshot=api.soundcloudSnapshot(document,source,collected);
 if(!snapshot.complete || snapshot.rows.map((r:any)=>r.title).join(',')!=='One,Two,Three')throw Error('SoundCloud lost offscreen positions or order');
 if(api.soundcloudSnapshot(document,'https://soundcloud.com/other/sets/wrong',new Map()))throw Error('Unrelated playlist metadata accepted');
});
console.log('PASS: SoundCloud retains track positions across scrolls and rejects partial or unrelated lists');
console.log('PASS: Spotify and SoundCloud extraction fixtures');
await page.setContent(`<yt-item-section-renderer><yt-lockup-view-model><h3><a href="/watch?v=abcdefghijk&list=OLAKtest&index=1">First song</a></h3></yt-lockup-view-model><yt-lockup-view-model><h3><a href="/watch?v=zyxwvutsrqp&list=OLAKtest&index=3">Third song</a></h3></yt-lockup-view-model><yt-lockup-view-model><h3><a href="/watch?v=12345678901&list=OTHER&index=1">Recommendation</a></h3></yt-lockup-view-model></yt-item-section-renderer>`);
await page.evaluate(()=>{
 const rows=(globalThis as any).__ytmImporter.collectProvider(document,'https://www.youtube.com/playlist?list=OLAKtest');
 if(rows.length!==3 || rows[0].title!=='First song' || rows[1].url!==null || rows[2].title!=='Third song')throw Error('Modern YouTube playlist extraction failed');
});
console.log('PASS: modern YouTube playlist layout, missing positions and recommendations');
const releasePage = await browser.newPage();
const target='https://musicbrainz.org/release/e1720d01-e7ee-4984-a0d8-4459b6ea80ee#mb-release-link=old-token';
await releasePage.route('https://musicbrainz.org/**',route=>route.fulfill({contentType:'text/html',body:'<div id="content"><h1>Release</h1><section><table class="details"><tr><td><a href="https://www.youtube.com/playlist?list=PL123">Playlist</a></td></tr></table></section></div>'}));
await releasePage.goto(target);
await releasePage.addScriptTag({content:await Deno.readTextFile(new URL('./LinkRecordingLevel.user.js',import.meta.url))});
await releasePage.locator('#link-recording-level-launch').waitFor();
await releasePage.evaluate(()=>{
 document.querySelector('section')!.innerHTML='<table class="details"><tr><td>Refreshed relationships</td></tr></table>';
});
await releasePage.locator('#link-recording-level-launch').waitFor();
if(await releasePage.locator('#link-recording-level-launch').count()!==1)throw Error('Duplicate importer buttons');
await releasePage.evaluate(()=>{document.querySelector('section')!.remove();document.querySelector('#link-recording-level-launch')?.remove();});
await releasePage.locator('#link-recording-level-launch').waitFor();
console.log('PASS: release marker reload, replaced relationships and no-table fallback');
await page.setContent(`<ytmusic-search-page><ytmusic-responsive-list-item-renderer><a class="title" href="/browse/MPREalbum">Album match</a></ytmusic-responsive-list-item-renderer><a href="/watch?v=abcdefghijk&list=RADIO">Song</a><a href="/browse/UCartist">Artist</a></ytmusic-search-page>`);
await page.evaluate(()=>{
 const results=(globalThis as any).__ytmImporter.youtubeAlbumResults(document);
 if(results.length!==1 || results[0].url!=='https://music.youtube.com/browse/MPREalbum')throw Error('Search collected a non-album result');
});
await page.setContent(`<ytmusic-responsive-header-renderer><a href="/watch?v=abcdefghijk&list=OLAKalbum">Play album</a><a href="/playlist?list=OLAKalbum">Playlist</a></ytmusic-responsive-header-renderer>`);
await page.evaluate(()=>{
 const results=(globalThis as any).__ytmImporter.youtubeAlbumResults(document,true);
 if(results.length!==1 || results[0].url!=='https://www.youtube.com/playlist?list=OLAKalbum')throw Error('Album playlist resolution failed');
});
await page.setContent(`<ytmusic-search-page><ytmusic-responsive-list-item-renderer><a class="title" href="/browse/MPREalbum">Album</a><a href="/watch?v=abcdefghijk&list=OLAKdirect">Play</a></ytmusic-responsive-list-item-renderer><a href="/watch?v=abcdefghijk&list=RADIO">Radio</a></ytmusic-search-page>`);
await page.evaluate(()=>{
 const api=(globalThis as any).__ytmImporter;
 let results=api.youtubeAlbumResults(document);
 if(results.length!==1 || results[0].url!=='https://www.youtube.com/playlist?list=OLAKdirect')throw Error('Album play link required a second page');
 const row=document.querySelector('ytmusic-responsive-list-item-renderer')! as any;
 row.querySelector('a[href^="/watch"]').remove();
 row.data={overlay:{musicItemThumbnailOverlayRenderer:{content:{musicPlayButtonRenderer:{playNavigationEndpoint:{watchPlaylistEndpoint:{playlistId:'OLAKendpoint'}}}}}}};
 results=api.youtubeAlbumResults(document);
 if(results.length!==1 || results[0].url!=='https://www.youtube.com/playlist?list=OLAKendpoint')throw Error('Album play endpoint was not captured');
 row.data.overlay.musicItemThumbnailOverlayRenderer.content.musicPlayButtonRenderer.playNavigationEndpoint.watchPlaylistEndpoint.playlistId='RDAMradio';
 results=api.youtubeAlbumResults(document);
 if(results.length!==1 || !results[0].url.includes('/browse/MPRE'))throw Error('Radio endpoint accepted as album');
});
console.log('PASS: search album cards supply playlist links directly and exclude radio endpoints');
console.log('PASS: barcode album candidates and canonical playlist capture');
await page.evaluate(()=>{
 const api=(globalThis as any).__ytmImporter;
 const result=api.albumLookupResults(document,'https://music.youtube.com/playlist?list=OLAKalbum','https://music.youtube.com/browse/MPREalbum');
 if(result.length!==1 || result[0].url!=='https://www.youtube.com/playlist?list=OLAKalbum')throw Error('Album redirect rejected');
 if(api.albumLookupResults(document,'https://evil.test/playlist?list=OLAKalbum','https://music.youtube.com/browse/MPREalbum').length)throw Error('Foreign redirect accepted');
});
console.log('PASS: Music album browse-to-playlist redirect capture');
await page.setContent(`<table class="details"><tr><th>stream for free:</th><td><a href="https://www.youtube.com/playlist?list=PLnew">New URL</a><a href="https://music.youtube.com/playlist?list=PLold">Existing URL</a></td></tr><tr><th>purchase for download:</th><td><a href="https://soundcloud.com/artist/sets/not-streaming">Purchase</a></td></tr></table>`);
await page.evaluate(()=>{
 const api=(globalThis as any).__ytmImporter;
 const release={relations:[{'target-type':'url',type:'stream for free',url:{resource:'https://www.youtube.com/playlist?list=PLold'}}]};
 const sources=api.currentStreamingSources(release,document);
 if(sources.length!==2 || !sources.some((s:any)=>s.url.endsWith('PLnew')))throw Error('New visible relationship missing or duplicate retained');
});
console.log('PASS: new visible release links supplement stale API and deduplicate');
await page.setContent(`<main><div role="grid" aria-rowcount="5"></div></main>`);
await page.evaluate(()=>{
 const api=(globalThis as any).__ytmImporter, collected=new Map();
 const grid=document.querySelector('[role="grid"]')!;
 const render=(positions:number[])=>{grid.innerHTML=positions.map(n=>`<div role="row" aria-rowindex="${n+1}"><div data-testid="tracklist-row">${n===2 ? '<span data-testid="track-name">Unavailable</span>' : `<a href="/track/${String(n).padStart(22,'0')}">Track ${n}</a>`}</div></div>`).join('');};
 const source='https://open.spotify.com/album/57TzZhbqvYoUBzJSVKFVlG';
 render([1,2]);
 if(api.spotifySnapshot(document,source,collected).complete)throw Error('Partial list accepted');
 render([3,4]);
 const result=api.spotifySnapshot(document,source,collected);
 if(!result.complete || result.rows.length!==4 || result.rows[0].title!=='Track 1' || result.rows[1].url!==null || result.rows[3].title!=='Track 4')throw Error('Virtualization lost order or unavailable slot');
});
console.log('PASS: Spotify virtualized positions accumulate, preserve unavailable rows, reject partial lists');
await page.setContent('<main><div role="grid" aria-rowcount="7"></div></main>');
await page.evaluate(()=>{
 const api=(globalThis as any).__ytmImporter, collected=new Map(), grid=document.querySelector('[role="grid"]')!;
 const track=(index:number,name:string)=>`<div role="presentation"><div role="row" aria-rowindex="${index}"><div data-testid="tracklist-row"><a href="/track/${String(index).padStart(22,'0')}">${name}</a></div></div></div>`;
 const heading='<div role="presentation"><div role="gridcell" aria-colindex="2">Disc</div></div>';
 const source='https://open.spotify.com/album/7CItFSiq0XApf0ZjBuo7fL';
 grid.innerHTML=heading+track(3,'A')+track(4,'B');
 if(api.spotifySnapshot(document,source,collected).complete)throw Error('First disc accepted alone');
 grid.innerHTML=heading+track(6,'C')+track(7,'D');
 const result=api.spotifySnapshot(document,source,collected);
 if(!result.complete || result.rows.map((r:any)=>r.title).join(',')!=='A,B,C,D')throw Error('Disc headings counted as tracks or disc order lost');
 const missing=new Map();grid.innerHTML=track(3,'A')+track(4,'B')+track(6,'C')+track(7,'D');
 if(api.spotifySnapshot(document,source,missing).complete)throw Error('Unknown gaps silently treated as disc headings');
});
console.log('PASS: Spotify disc dividers excluded, multi-disc order retained, unexplained gaps rejected');
const lifecycle = await browser.newPage();
await lifecycle.route('https://open.spotify.com/**', route=>route.fulfill({body:'<main></main>',contentType:'text/html'}));
await lifecycle.goto('https://open.spotify.com/album/57TzZhbqvYoUBzJSVKFVlG');
await lifecycle.evaluate(()=>{(globalThis as any).__ytmImporterTesting=true});
await lifecycle.addScriptTag({content:await Deno.readTextFile(new URL('./LinkRecordingLevel.user.js',import.meta.url))});
await lifecycle.evaluate(async()=>{
 const g=globalThis as any;let now=100000, hidden=true, tick:any, result:any;
 const originalNow=Date.now,originalInterval=window.setInterval,originalClear=window.clearInterval;
 const request={url:location.href,created:now};
 Date.now=()=>now;
 Object.defineProperty(document,'hidden',{configurable:true,get:()=>hidden});
 g.GM_getValue=async()=>request;g.GM_setValue=async(_key:any,value:any)=>{result=value};
 window.setInterval=((fn:any)=>{tick=fn;return 1}) as any;window.clearInterval=(()=>{}) as any;
 try {
  await g.__ytmImporter.sourceWorker('test');
  now+=90000;tick();await Promise.resolve();
  if(result)throw Error('Hidden Spotify worker expired before activation');
  hidden=false;tick();await Promise.resolve();
  if(result)throw Error('Hidden time charged to active budget');
  document.querySelector('main')!.innerHTML='<div role="grid" aria-rowcount="2"><div role="row" aria-rowindex="2"><div data-testid="tracklist-row"><a href="/track/2rTP0iwaMxRy2HFW2nHKq9">Track</a></div></div></div>';
  now+=500;tick();await Promise.resolve();await Promise.resolve();
  if(result?.rows?.length!==1)throw Error('Collection did not resume after activation');
 } finally {Date.now=originalNow;window.setInterval=originalInterval;window.clearInterval=originalClear;delete (document as any).hidden;}
});
await lifecycle.close();
console.log('PASS: Spotify waits through 90 seconds hidden and collects after activation');
await page.setContent(`<table class="details"><tr><td><a href="https://www.youtube.com/playlist?list=PL123">YouTube</a></td></tr></table><section id="import"></section>`);
await page.evaluate(()=>{
 const api=(globalThis as any).__ytmImporter, box=document.querySelector('#import')!;
 api.offerBarcodeSearch(box,null,'e1720d01-e7ee-4984-a0d8-4459b6ea80ee');
 if(!box.querySelector('input[type="url"]') || ![...box.querySelectorAll('button')].some((b:any)=>b.textContent==='Add URL'))throw Error('Manual URL form waited for release metadata');
 if(!api.releaseHasUrl(null,'https://www.youtube.com/playlist?list=PL123',document))throw Error('Visible existing URL was not detected');
 if(api.barcodeSearchUrl(null)!==null)throw Error('Missing release metadata should skip barcode lookup');
});
console.log('PASS: manual release URL UI works before full release metadata arrives');
const importerSource = await Deno.readTextFile(new URL('./LinkRecordingLevel.user.js', import.meta.url));
const initialPage = await browser.newPage();
await initialPage.route('**/*', route => route.fulfill({contentType:'text/html',body:'<main id="content"><h1>Release</h1></main>'}));
await initialPage.addInitScript(() => {
 const g=globalThis as any;
 g.GM_listValues=async()=>[];
 g.GM_xmlhttpRequest=(request:any)=>{g.releaseRequest=request};
});
await initialPage.addInitScript({content:importerSource});
await initialPage.goto('https://musicbrainz.org/release/e1720d01-e7ee-4984-a0d8-4459b6ea80ee');
await initialPage.getByRole('button',{name:'Import recording links',exact:true}).click();
await initialPage.waitForFunction(()=>document.querySelector('#ytm-mb-import')?.textContent?.includes('Loading…'));
await initialPage.evaluate(()=>{
 (globalThis as any).releaseRequest.onload({status:200,responseText:JSON.stringify({media:[{position:1,tracks:[{position:1,title:'Track',recording:{id:'e1720d01-e7ee-4984-a0d8-4459b6ea80ee'}}]}],relations:[]})});
});
await initialPage.getByRole('button',{name:'Collect selected providers',exact:true}).waitFor();
if(await initialPage.locator('#ytm-mb-import').textContent().then(text=>text?.includes('Loading…')))throw Error('Idle importer retained loading text');
await initialPage.getByRole('button',{name:'Collect selected providers',exact:true}).click();
if(!await initialPage.locator('#ytm-mb-import').textContent().then(text=>text?.includes('Select a provider.')))throw Error('Status errors were detached');
await initialPage.close();
console.log('PASS: initial loading clears when provider picker is ready; validation stays visible');

const editorPage=await browser.newPage();
let unblock!:()=>void;
const blocked=new Promise<void>(resolve=>{unblock=resolve});
await editorPage.route('**/*',async route=>{
 if(route.request().url().endsWith('/slow.js')){await blocked;await route.fulfill({contentType:'text/javascript',body:''});return;}
 await route.fulfill({contentType:'text/html',body:'<body><div class="external-link-item"><input class="value" value="https://example.com/album"></div><script src="/slow.js"></script></body>'});
});
await editorPage.addInitScript(()=>{
 const g=globalThis as any, url='https://example.com/album';
 g.GM_getValue=async()=>({id:'e1720d01-e7ee-4984-a0d8-4459b6ea80ee',url,created:Date.now()});
 g.GM_setValue=async()=>{};
 g.unsafeWindow=window;
 g.MB={tree:{iterate:(value:any)=>value},_releaseEditor:{externalLinksData:()=>[{url,relationships:[{linkTypeID:85}]}],allEdits:()=>[{}],allowsSubmission:()=>true,submitEdits:()=>{g.submittedAt=document.readyState}}};
});
await editorPage.addInitScript({content:importerSource});
try {
 await editorPage.goto('https://musicbrainz.org/release/e1720d01-e7ee-4984-a0d8-4459b6ea80ee/edit#mb-release-link=test',{waitUntil:'commit'});
 await editorPage.waitForFunction(()=>(globalThis as any).submittedAt==='loading',{},{timeout:5000});
 if(!await editorPage.locator('#ytm-mb-import').textContent().then(text=>text?.includes('Saving release URL…')))throw Error('Save progress missing');
} finally {unblock();await editorPage.close();}
console.log('PASS: ready release editor submits while unrelated page script still blocks DOMContentLoaded');
const addPage=await browser.newPage();
await addPage.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<main id="content"><h1>Release</h1></main>'}));
await addPage.addInitScript(()=>{
 const g=globalThis as any;
 g.GM_listValues=async()=>[];
 g.GM_xmlhttpRequest=()=>{};
 g.GM_setValue=(_key:string,value:any)=>{g.savedReleaseUrl=value.url;return new Promise(()=>{})};
});
await addPage.addInitScript({content:importerSource});
await addPage.goto('https://musicbrainz.org/release/e1720d01-e7ee-4984-a0d8-4459b6ea80ee');
await addPage.getByRole('button',{name:'Import recording links',exact:true}).click();
await addPage.getByPlaceholder('Release URL',{exact:true}).fill('https://www.youtube.com/playlist?list=OLAKtest');
await addPage.getByRole('button',{name:'Add URL',exact:true}).click();
await addPage.waitForFunction(()=>(globalThis as any).savedReleaseUrl==='https://www.youtube.com/playlist?list=OLAKtest',{}, {timeout:1500});
await addPage.close();
console.log('PASS: paste URL then click Add URL once saves the draft despite input blur');
const resumePage=await browser.newPage();
await resumePage.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<main id="content"><h1>Release</h1></main>'}));
await resumePage.addInitScript(()=>{
 const g=globalThis as any,id='e1720d01-e7ee-4984-a0d8-4459b6ea80ee',key='release-stream-import-v3:batch:saved';
 if(!sessionStorage.getItem('fixture-started')) {
   sessionStorage.setItem('fixture-started','true');
   sessionStorage.setItem('fixture-values',JSON.stringify({[key]:{batchId:'saved',runId:'old',release:id,source:`https://musicbrainz.org/release/${id}`,created:Date.now()-86400000,index:0,submitted:false,jobs:[{id,title:'Track',url:'https://www.youtube.com/watch?v=abcdefghijk'}]}}));
 }
 const values=()=>JSON.parse(sessionStorage.getItem('fixture-values')!);
 g.GM_listValues=async()=>Object.keys(values());g.GM_getValue=async(key:string,fallback:any=null)=>values()[key]??fallback;
 g.GM_setValue=async(key:string,value:any)=>{sessionStorage.setItem('fixture-values',JSON.stringify({...values(),[key]:value}))};
 g.GM_xmlhttpRequest=(request:any)=>{
   if(!request.url.includes('/recording/'))return;
   const first=!sessionStorage.getItem('fixture-checked');sessionStorage.setItem('fixture-checked','true');
   request.onload({status:200,responseText:JSON.stringify({id,relations:first?[]:[{'target-type':'url',url:{resource:'https://www.youtube.com/watch?v=abcdefghijk'}}]})});
 };
 g.GM_openInTab=()=>{throw Error('Recording imports must not open another tab')};
});
await resumePage.addInitScript({content:importerSource});
const releaseUrl='https://musicbrainz.org/release/e1720d01-e7ee-4984-a0d8-4459b6ea80ee';
await resumePage.goto(releaseUrl);
await resumePage.getByRole('button',{name:'Import recording links',exact:true}).click();
await resumePage.getByRole('button',{name:'Resume import',exact:true}).click();
await resumePage.getByText('Import complete',{exact:true}).waitFor();
if(resumePage.url()!==releaseUrl || resumePage.isClosed())throw Error('Import did not return to release in the original tab');
if(!await resumePage.locator('#ytm-mb-import').textContent().then(text=>text?.includes('1 recordings processed')))throw Error('Completion summary missing');
await resumePage.close();
console.log('PASS: recording import navigates the original tab and returns to release with completion summary');
await browser.close();
