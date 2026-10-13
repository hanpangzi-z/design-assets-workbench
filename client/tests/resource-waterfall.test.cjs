const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),test=require('node:test'),ts=require('typescript');
const filename=path.resolve(__dirname,'../src/components/ResourceWaterfall/layout.ts');
const code=ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const context={exports:{},require:name=>name.includes('assetPreview')?{getAssetPreviewPath:f=>f.thumbnailPath}:require(name)};
vm.runInNewContext(code,context,{filename});const {buildLayout,visiblePlacements,findAnchor,previewHeight,previewKey}=context.exports;
const file=(id,ratio=1)=>({id,name:'sample '+id,width:100,height:100*ratio,thumbnailPath:'thumbnails/'+id+'.png',updatedAt:'v1'});
const files=Array.from({length:3000},(_,i)=>file(i+1,[.2,.75,1,1.5,3,12][i%6]));

test('appending a page retains every original placement and follows shortest-column allocation',()=>{
 const first=buildLayout(files.slice(0,40),1530,new Map());const next=buildLayout(files.slice(0,80),1530,new Map(),first);
 assert.deepEqual(next.positions.slice(0,40),first.positions);assert.equal(first.columnCount,5);
 const last=first.positions.at(-1);assert.ok(last.top>=0);assert.ok(next.height>=first.height);
 for(const p of next.positions){assert.ok(p.left>=0&&p.left+p.width<=1530.01);assert.ok(p.previewHeight>=80&&p.previewHeight<=960);}
 for(const p of next.positions){const below=next.positions.filter(x=>x.column===p.column&&x.index>p.index)[0];if(below)assert.equal(below.top,p.top+p.height+20);}
});
test('real thumbnail proportions override document dimensions, missing values fall back, and version changes invalidate measurements',()=>{
 const f=file(1,3),ratios=new Map([[previewKey(f),.5]]);
 assert.equal(previewHeight(f,240,ratios),128);assert.equal(previewHeight({...f,updatedAt:'v2'},240,ratios),688);
 assert.equal(previewHeight({id:2},240,new Map()),184);assert.equal(previewHeight(file(3,100),240,new Map()),960);
 assert.equal(previewHeight(file(4,.01),240,new Map()),80);
 assert.equal(previewHeight({...file(5,12),fileType:'ttf',thumbnailPath:null},240,new Map()),184);
});
test('proportion correction keeps membership stable; resizing recomputes geometry and preserves anchor identity',()=>{
 const first=buildLayout(files.slice(0,80),1530,new Map()),anchor=findAnchor(first,2100,800);assert.ok(anchor);
 const updated=buildLayout(files.slice(0,80),1530,new Map([[previewKey(files[0]),4]]),first);
 assert.deepEqual(updated.positions.map(p=>p.column),first.positions.map(p=>p.column));
 const resized=buildLayout(files.slice(0,80),990,new Map(),updated),entry=resized.positions.find(p=>p.id===anchor.id);
 const newTop=entry.top-anchor.offset;assert.equal(entry.top-newTop,anchor.offset);assert.equal(resized.columnCount,3);
});
test('3000 files use a bounded viewport slice and retain only active focus/menu pins',()=>{
 const layout=buildLayout(files,1614,new Map());const visible=visiblePlacements(layout,25000,900,new Set([files[0].id]));
 assert.ok(visible.length<100);assert.ok(visible.some(p=>p.id===files[0].id));assert.ok(visible.some(p=>p.top>25000));
 const bottom=visiblePlacements(layout,layout.height-900,900);assert.ok(bottom.some(p=>p.id===files.at(-1).id));
 assert.equal(new Set(layout.positions.map(p=>p.id)).size,3000);
});
test('resetting sort or filtering reallocates in supplied order; tiny and invalid containers remain finite',()=>{
 const first=buildLayout(files.slice(0,40),1000,new Map());const reversed=buildLayout(files.slice(0,40).reverse(),1000,new Map(),first);
 assert.equal(reversed.positions[0].id,40);assert.equal(reversed.positions[0].top,0);
 for(const width of [0,NaN,50,220,Infinity]){const result=buildLayout(files.slice(0,5),width,new Map());assert.ok(result.positions.every(p=>Number.isFinite(p.width)&&p.width>0&&Number.isFinite(p.height)));}
 assert.equal(buildLayout([],1200,new Map()).height,0);
});
