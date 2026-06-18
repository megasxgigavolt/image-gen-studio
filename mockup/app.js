const baseSentences=[
 {id:1,start:0,end:4.1,text:"The sunlight fades beneath the waves."},{id:2,start:4.1,end:8.4,text:"The familiar blue begins to disappear."},
 {id:3,start:8.4,end:13.2,text:"Two hundred meters down, a hidden world begins."},{id:4,start:13.2,end:17.2,text:"Oceanographers call it the twilight zone."},
 {id:5,start:17.2,end:21.3,text:"Here, every fragment of light becomes precious."},{id:6,start:21.3,end:26.4,text:"Vision gives way to other, stranger senses."},
 {id:7,start:26.4,end:31.1,text:"Far below the sunlit surface lies a world suspended between light and darkness."},{id:8,start:31.1,end:35.8,text:"It stretches across every ocean on Earth."},
 {id:9,start:35.8,end:40.2,text:"Lanternfish produce their own cold, living light."},{id:10,start:40.2,end:44.1,text:"Millions rise toward the surface each night."},
 {id:11,start:44.1,end:48.4,text:"Their glow conceals them from predators watching below."},{id:12,start:48.4,end:53.7,text:"A perfect disguise made from light itself."},
 {id:13,start:53.7,end:58,text:"But the darkness also belongs to patient hunters."},{id:14,start:58,end:62,text:"Some wait motionless for hours."},
 {id:15,start:62,end:66.4,text:"A chain of life moves through this immense vertical habitat."},{id:16,start:66.4,end:70.6,text:"Every night, that chain rises toward the stars."}
];
const labels=["Ocean descent","Twilight boundary","Blue light shafts","Open ocean","Lanternfish","Counterillumination","Deep-sea hunter","Food chain"];
const filmScenes=[
 ["00:00.0","00:08.4","The sunlight fades beneath the waves.","Ocean descent"],["00:08.4","00:17.2","Two hundred meters down, a hidden world begins.","Twilight boundary"],
 ["00:17.2","00:26.4","Here, every fragment of light becomes precious.","Blue light shafts"],["00:26.4","00:35.8","Far below the sunlit surface lies a world suspended between light and darkness.","Open ocean"],
 ["00:35.8","00:44.1","Lanternfish produce their own cold, living light.","Lanternfish"],["00:44.1","00:53.7","Their glow conceals them from predators watching below.","Counterillumination"],
 ["00:53.7","01:02.0","But the darkness also belongs to patient hunters.","Deep-sea hunter"],["01:02.0","01:10.6","A chain of life moves through this immense vertical habitat.","Food chain"]
];
let groups,draggedSentenceId=null;
const resetGroups=()=>groups=Array.from({length:8},(_,i)=>({label:labels[i],type:i%3===0?"Establishing":i%3===1?"Subject":"Concept",sentenceIds:[i*2+1,i*2+2]}));
const sentenceById=id=>baseSentences.find(s=>s.id===id);
const fmtTime=s=>`${String(Math.floor(s/60)).padStart(2,"0")}:${(s%60).toFixed(1).padStart(4,"0")}`;
const sceneList=document.getElementById("sceneList");
resetGroups();

function toast(message){const el=document.getElementById("toast");el.textContent=message;el.classList.add("show");setTimeout(()=>el.classList.remove("show"),2200)}
function renderPlan(){
 sceneList.innerHTML="";
 groups.forEach((group,i)=>{
  const sentences=group.sentenceIds.map(sentenceById).sort((a,b)=>a.start-b.start),start=sentences[0].start,end=sentences.at(-1).end;
  sceneList.insertAdjacentHTML("beforeend",`<article class="scene-row ${i===5?"flagged":""}" data-group="${i}">
   <span class="scene-index">${String(i+1).padStart(2,"0")}</span><div class="scene-time"><strong>${fmtTime(start)} – ${fmtTime(end)}</strong><small>${(end-start).toFixed(1)} sec · ${sentences.length} sentence${sentences.length===1?"":"s"}</small></div>
   <div class="sentence-stack">${sentences.map(s=>`<div class="sentence-card" draggable="true" data-sentence="${s.id}"><span class="sentence-handle">⠿</span><p>${s.text}</p><small>${fmtTime(s.start)}</small></div>`).join("")}</div>
   <div class="scene-meta"><span class="scene-type">${group.type}</span><small>${group.label}</small></div><div class="scene-tools"><button title="Rewrite">✎</button><button title="More">⋯</button></div>
  </article><div class="drop-divider" data-insert="${i+1}"></div>`);
 });
 document.getElementById("stillCount").textContent=`${groups.length} stills`;
 document.getElementById("planSummary").textContent=`01:10 total · Average ${(70.6/groups.length).toFixed(1)} sec`;
 wirePlanDnD();
}
function moveSentence(id,targetIndex,createNew){
 const sourceIndex=groups.findIndex(g=>g.sentenceIds.includes(id));if(sourceIndex<0)return;
 if(!createNew&&sourceIndex===targetIndex)return;
 groups[sourceIndex].sentenceIds=groups[sourceIndex].sentenceIds.filter(x=>x!==id);
 if(groups[sourceIndex].sentenceIds.length===0){groups.splice(sourceIndex,1);if(sourceIndex<targetIndex)targetIndex--}
 if(createNew)groups.splice(targetIndex,0,{label:"New scene",type:"Custom",sentenceIds:[id]});else groups[targetIndex].sentenceIds.push(id);
 groups.sort((a,b)=>Math.min(...a.sentenceIds)-Math.min(...b.sentenceIds));renderPlan();
 toast(createNew?"New still created · timestamps recalculated":"Scenes merged · timestamps recalculated");
}
function wirePlanDnD(){
 document.querySelectorAll(".sentence-card").forEach(card=>{card.addEventListener("dragstart",()=>{draggedSentenceId=Number(card.dataset.sentence);card.classList.add("dragging")});card.addEventListener("dragend",()=>card.classList.remove("dragging"))});
 document.querySelectorAll(".scene-row").forEach(row=>{row.addEventListener("dragover",e=>{e.preventDefault();row.classList.add("drag-over")});row.addEventListener("dragleave",()=>row.classList.remove("drag-over"));row.addEventListener("drop",e=>{e.preventDefault();row.classList.remove("drag-over");moveSentence(draggedSentenceId,Number(row.dataset.group),false)})});
 document.querySelectorAll(".drop-divider").forEach(div=>{div.addEventListener("dragover",e=>{e.preventDefault();div.classList.add("drag-over")});div.addEventListener("dragleave",()=>div.classList.remove("drag-over"));div.addEventListener("drop",e=>{e.preventDefault();div.classList.remove("drag-over");moveSentence(draggedSentenceId,Number(div.dataset.insert),true)})});
}
renderPlan();
document.getElementById("resetPlan").addEventListener("click",()=>{resetGroups();renderPlan();toast("Visual plan reset")});

const filmItems=document.getElementById("filmItems");
filmScenes.forEach((s,i)=>filmItems.insertAdjacentHTML("beforeend",`<button class="film-item ${i<5?"done":""} ${i===3?"active":""}"><div class="film-thumb"><span>${i<5?"v"+(i%3+1):"Pending"}</span></div><p>${String(i+1).padStart(2,"0")} · ${s[3]}</p></button>`));
function showPage(id){document.querySelectorAll(".page").forEach(p=>p.classList.toggle("active",p.id===id));document.querySelectorAll(".nav-item[data-page]").forEach(n=>n.classList.toggle("active",n.dataset.page===id));window.scrollTo(0,0)}
document.querySelectorAll("[data-page]").forEach(b=>b.addEventListener("click",()=>showPage(b.dataset.page)));
document.querySelectorAll("[data-go]").forEach(b=>b.addEventListener("click",()=>showPage(b.dataset.go)));
document.getElementById("pace").addEventListener("input",e=>document.getElementById("paceValue").textContent=`${e.target.value} sec`);
document.getElementById("styleToggle").addEventListener("click",()=>{document.getElementById("styleDetails").classList.toggle("open");document.getElementById("styleChevron").textContent=document.getElementById("styleDetails").classList.contains("open")?"⌃":"⌄"});
document.querySelectorAll(".tabs button").forEach(b=>b.addEventListener("click",()=>{document.querySelectorAll(".tabs button").forEach(x=>x.classList.remove("active"));document.querySelectorAll(".tab-content").forEach(x=>x.classList.remove("active"));b.classList.add("active");document.getElementById(b.dataset.tab).classList.add("active")}));
document.getElementById("suggestBtn").addEventListener("click",()=>document.getElementById("suggestion").classList.remove("hidden"));
document.getElementById("useSuggestion").addEventListener("click",()=>{document.querySelector(".prompt-box").value+=" Emphasize the transition from blue surface light to near-black water, with a lone lanternfish establishing scale.";document.getElementById("suggestion").classList.add("hidden")});
document.getElementById("generateBtn").addEventListener("click",()=>toast("Generating a new version for still 04…"));
document.getElementById("bulkBtn").addEventListener("click",e=>{e.currentTarget.textContent="Ⅱ Pause generation";toast("Bulk generation started · 6 stills pending")});
document.querySelectorAll(".film-item").forEach((b,i)=>b.addEventListener("click",()=>{document.querySelectorAll(".film-item").forEach(x=>x.classList.remove("active"));b.classList.add("active");document.querySelector(".scene-number").textContent=`Still ${String(i+1).padStart(2,"0")}`;document.querySelector(".timeline-copy p").textContent=filmScenes[i][2]}));
