/* =============================================
   PREXEC — GitHub PR Analyzer
   ============================================= */

const GITHUB_API = 'https://api.github.com';
const PAGE_SIZE = 20;
let rateLimitResetTime = 0;
let rateLimitTimer = null;
let chartInstances = {};

const PR_TYPES = {
    'Bug Fix':['fix','bug','issue','error','crash','broken','patch','hotfix','resolve','repair','correct','debug','defect'],
    'Feature':['feature','add','new','implement','create','introduce','support','enable','allow','enhancement'],
    'Documentation':['doc','readme','documentation','comment','guide','tutorial','wiki','changelog','license','contributing','docstring'],
    'Refactor':['refactor','restructure','reorganize','cleanup','clean up','simplify','rewrite','modernize'],
    'Dependency':['dependency','dependencies','package','npm','pip','yarn','upgrade','bump','dependabot','renovate'],
    'Test':['test','testing','spec','unit test','e2e','coverage','jest','pytest','mocha','cypress'],
    'Performance':['performance','optimize','speed','faster','efficient','memory','cache','benchmark'],
    'Style/Lint':['style','lint','format','prettier','eslint','formatting','black','flake8'],
    'Config':['config','configuration','settings','env','ci/cd','workflow','github action','docker','yaml'],
    'Security':['security','vulnerability','cve','xss','csrf','auth','encrypt','ssl','sanitize'],
};
const TOOL_BOTS = {'Dependabot':['dependabot','dependabot[bot]'],'Renovate Bot':['renovate','renovate[bot]'],'GitHub Actions':['github-actions','github-actions[bot]'],'Snyk Bot':['snyk','snyk[bot]']};
const TOOL_HINTS = {'GitHub CLI':['gh pr create','via github cli'],'VS Code':['vscode'],'JetBrains':['intellij','pycharm','webstorm']};
const TYPE_COLORS = {'Bug Fix':'#ef4444','Feature':'#3c83f6','Documentation':'#a78bfa','Refactor':'#f59e0b','Dependency':'#f97316','Test':'#10b981','Performance':'#ec4899','Style/Lint':'#6366f1','Config':'#64748b','Security':'#e11d48','General':'#60a5fa'};
const TOOL_COLORS = ['#3c83f6','#10b981','#f59e0b','#ef4444','#a78bfa','#ec4899','#f97316','#14b8a6'];

const S = {data:null,user:'',type:'quick',page:1,filtered:[],all:[]};
const $ = id => document.getElementById(id);

document.addEventListener('DOMContentLoaded', () => { checkRate(); bind(); });

async function checkRate() {
    try {
        const r = await fetch(GITHUB_API+'/rate_limit');
        const d = await r.json();
        const rate = d.rate||{};
        const remaining = rate.remaining||0;
        const limit = rate.limit||60;
        rateLimitResetTime = (rate.reset||0)*1000;
        $('rateLimitBadge').textContent = remaining+'/'+limit;
        const dot = $('apiDot');
        if(remaining<5) dot.className='w-2 h-2 rounded-full bg-red-500 animate-pulse';
        else if(remaining<20) dot.className='w-2 h-2 rounded-full bg-yellow-400 animate-pulse';
        else dot.className='w-2 h-2 rounded-full bg-success animate-pulse';
        if(remaining<=0) { showRateLimitBlock(); return false; }
        hideRateLimitBlock();
        return true;
    } catch(e) { $('rateLimitBadge').textContent='N/A'; return true; }
}

function showRateLimitBlock() {
    showSec('rateLimit');
    if(rateLimitTimer) clearInterval(rateLimitTimer);
    updateCountdown();
    rateLimitTimer = setInterval(updateCountdown, 1000);
}

function hideRateLimitBlock() {
    $('rateLimitSection').style.display='none';
    if(rateLimitTimer){clearInterval(rateLimitTimer);rateLimitTimer=null;}
}

function updateCountdown() {
    const now = Date.now();
    const diff = Math.max(0, rateLimitResetTime - now);
    if(diff <= 0) {
        $('rateLimitCountdown').textContent = '00:00';
        $('rateLimitCountdown').classList.add('text-success');
        if(rateLimitTimer){clearInterval(rateLimitTimer);rateLimitTimer=null;}
        return;
    }
    const min = Math.floor(diff/60000);
    const sec = Math.floor((diff%60000)/1000);
    $('rateLimitCountdown').textContent = String(min).padStart(2,'0')+':'+String(sec).padStart(2,'0');
    $('rateLimitCountdown').classList.remove('text-success');
}

function bind() {
    $('btnQuickScan').onclick = () => scan('quick');
    $('btnDeepScan').onclick = () => scan('deep');
    $('usernameInput').onkeydown = e=>{if(e.key==='Enter')scan('deep');};
    $('btnRetry').onclick = ()=>{showSec('search');$('usernameInput').focus();};
    $('btnRateLimitRetry').onclick = async()=>{const ok=await checkRate();if(ok)showSec('search');};

    const newFn=()=>{S.data=null;destroyCharts();showSec('search');$('usernameInput').value='';$('usernameInput').focus();const nd=$('navDashboard');if(nd)nd.style.display='none';};
    $('btnNewScan').onclick=newFn;
    if($('btnNewScan2'))$('btnNewScan2').onclick=newFn;
    if($('logoHomeLink'))$('logoHomeLink').onclick=(e)=>{e.preventDefault();newFn();};

    if($('heatmapYearSelect'))$('heatmapYearSelect').onchange=()=>{if(S.data)renderHeatmapGH(S.data.stats).catch(e=>console.warn('Heatmap error:',e));};

    const af=()=>filterTable();
    ['tblFilterStatus','tblFilterType','tblFilterRepo'].forEach(id=>{if($(id))$(id).onchange=af;});
    if($('tblSearch'))$('tblSearch').oninput=af;
    $('tblPrev').onclick=()=>tblPage(-1);
    $('tblNext').onclick=()=>tblPage(1);

    $('btnExportJSON').onclick=exJSON;$('btnExportCSV').onclick=exCSV;$('btnExportMD').onclick=exMD;
    if($('btnExportJSON2'))$('btnExportJSON2').onclick=exJSON;
    if($('btnExportCSV2'))$('btnExportCSV2').onclick=exCSV;
    if($('btnExportMD2'))$('btnExportMD2').onclick=exMD;

    $('btnThemeToggle').onclick=()=>{
        document.documentElement.classList.toggle('dark');
        $('btnThemeToggle').querySelector('.material-symbols-outlined').textContent=document.documentElement.classList.contains('dark')?'dark_mode':'light_mode';
    };
}

function showSec(name) {
    ['searchSection','loadingSection','errorSection','resultsSection','rateLimitSection'].forEach(id=>$(id).style.display='none');
    $(name+'Section').style.display='';
}

function setPhase(n,pct,msg) {
    $('loadingBar').style.width=pct+'%';$('loadingStatus').textContent=msg;
    for(let i=1;i<=4;i++){const el=$('lPhase'+i);if(!el)continue;const icon=el.querySelector('.material-symbols-outlined');el.classList.remove('done','active');
    if(i<n){el.classList.add('done');icon.textContent='check_circle';}else if(i===n){el.classList.add('active');icon.textContent='sync';}else{icon.textContent='hourglass_empty';}}
}

async function ghGet(url) {
    const r=await fetch(url,{headers:{'User-Agent':'prexec-app'}});
    if(r.status===403){
        const b=await r.json().catch(()=>({}));
        if(b.message&&b.message.includes('rate limit')){await checkRate();throw new Error('RATE_LIMIT');}
        throw new Error(b.message||'Forbidden');
    }
    if(!r.ok){const b=await r.json().catch(()=>({}));throw new Error(b.message||'HTTP '+r.status);}
    return r.json();
}

function detectType(t,b){const tl=(t||'').toLowerCase(),bl=(b||'').toLowerCase();let best=null,bs=0;for(const[type,kws] of Object.entries(PR_TYPES)){let sc=0;for(const kw of kws){if(tl.includes(kw))sc+=2;if(bl.includes(kw))sc+=1;}if(sc>bs){bs=sc;best=type;}}return best||'General';}
function detectTool(u,b){const ul=(u||'').toLowerCase(),bl=(b||'').toLowerCase();for(const[t,p]of Object.entries(TOOL_BOTS))for(const pp of p)if(ul.includes(pp))return t;for(const[t,h]of Object.entries(TOOL_HINTS))for(const hh of h)if(bl.includes(hh))return t;if(bl.trim().length<20)return'Git CLI';return'GitHub Web';}
function destroyCharts(){Object.values(chartInstances).forEach(c=>{if(c&&c.destroy)c.destroy();});chartInstances={};}

function formatDateKey(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + d;
}

async function scan(type){
    const user=$('usernameInput').value.trim();
    if(!user){$('usernameInput').focus();return;}
    const ok=await checkRate();
    if(!ok)return;
    S.user=user;S.type=type;
    $('btnQuickScan').disabled=$('btnDeepScan').disabled=true;
    showSec('loading');$('loadingTitle').textContent="Analyzing @"+user;
    try{
        setPhase(1,10,'Verifying user...');
        const userData=await ghGet(GITHUB_API+'/users/'+encodeURIComponent(user));
        await sleep(200);

        setPhase(2,25,'Fetching pull requests...');
        const allPRs=[];let pg=1;const maxPg=5;
        while(pg<=maxPg){
            setPhase(2,25+(pg/maxPg)*25,'Page '+pg+'...');
            const data=await ghGet(GITHUB_API+'/search/issues?q=author:'+encodeURIComponent(user)+'+type:pr&per_page=100&page='+pg);
            allPRs.push(...(data.items||[]));
            if((data.items||[]).length<100)break;pg++;await sleep(150);
        }

        setPhase(3,60,'Analyzing '+allPRs.length+' PRs...');await sleep(200);
        const stats=analyze(allPRs);

        setPhase(4,90,'Building visualizations...');await sleep(300);
        S.data={user:{login:userData.login||'',name:userData.name||'',avatar_url:userData.avatar_url||'',location:userData.location||'',bio:userData.bio||'',public_repos:userData.public_repos||0,followers:userData.followers||0,created_at:(userData.created_at||'').slice(0,10),html_url:userData.html_url||''},stats};
        setPhase(4,100,'Complete!');await sleep(150);
        destroyCharts();render(S.data,type);showSec('results');checkRate();
    }catch(err){
        if(err.message==='RATE_LIMIT')return;
        let msg=err.message||'Unknown error';
        if(msg.includes('Not Found'))msg="User '"+user+"' not found.";
        $('errorTitle').textContent='Analysis Failed';$('errorMessage').textContent=msg;showSec('error');
    }finally{$('btnQuickScan').disabled=$('btnDeepScan').disabled=false;}
}

function analyze(prs){
    let merged=0,pending=0,closed=0,draft=0,stale=0;
    const repoC={},yearly={},monthly={},daily={},typeC={},toolC={},repoStats={};
    const details=[],prDates=[];

    for(const pr of prs){
        const repoUrl=pr.repository_url||'';const parts=repoUrl.split('/');
        const repo=parts.length>=2?parts[parts.length-2]+'/'+parts[parts.length-1]:'unknown';
        repoC[repo]=(repoC[repo]||0)+1;
        if(!repoStats[repo])repoStats[repo]={total:0,merged:0,pending:0,closed:0};
        repoStats[repo].total++;

        const ca=pr.created_at||'1970-01-01T00:00:00Z';
        yearly[ca.slice(0,4)]=(yearly[ca.slice(0,4)]||0)+1;
        monthly[ca.slice(0,7)]=(monthly[ca.slice(0,7)]||0)+1;
        daily[ca.slice(0,10)]=(daily[ca.slice(0,10)]||0)+1;

        const state=pr.state||'unknown';if(pr.draft)draft++;
        const title=pr.title||'',body=pr.body||'',uLogin=(pr.user||{}).login||'';
        const prType=detectType(title,body);typeC[prType]=(typeC[prType]||0)+1;
        const tool=detectTool(uLogin,body);toolC[tool]=(toolC[tool]||0)+1;
        const prd=pr.pull_request||{};const isMerged=!!prd.merged_at;

        if(state==='open'){pending++;repoStats[repo].pending++;try{if((Date.now()-new Date(ca).getTime())/86400000>180)stale++;}catch(e){}}
        else if(state==='closed'){if(isMerged){merged++;repoStats[repo].merged++;}else{closed++;repoStats[repo].closed++;}}

        try{prDates.push({date:new Date(ca).toISOString(),state,merged:isMerged});}catch(e){}
        details.push({repo,number:pr.number||0,title,status:isMerged?'merged':state,url:pr.html_url||'',created_at:ca.slice(0,10),type:prType,tool});
    }

    const total=merged+pending+closed;
    const acceptance=total>0?Math.round((merged/total)*10000)/100:0;
    const topRepos=Object.entries(repoC).sort((a,b)=>b[1]-a[1]);

    const prodDates=[],prodScores=[];
    const sorted=[...prDates].sort((a,b)=>a.date.localeCompare(b.date));
    if(sorted.length>=2){
        const diffs=[];for(let i=1;i<sorted.length;i++){try{diffs.push((new Date(sorted[i].date)-new Date(sorted[i-1].date))/3600000);}catch(e){}}
        const avg=diffs.length?diffs.reduce((a,b)=>a+b,0)/diffs.length:24;
        let score=50;prodDates.push(sorted[0].date);prodScores.push(score);
        for(let i=1;i<sorted.length;i++){
            let td;try{td=(new Date(sorted[i].date)-new Date(sorted[i-1].date))/3600000;}catch(e){td=avg;}
            let ch=0;if(td<avg)ch+=Math.min(((avg-td)/Math.max(avg,1))*15,10);else ch-=Math.min(((td-avg)/Math.max(avg,1))*10,15);
            if(sorted[i].merged)ch+=5;else if(sorted[i].state==='closed')ch-=3;
            score=Math.max(5,Math.min(95,score+ch));prodDates.push(sorted[i].date);prodScores.push(Math.round(score*10)/10);
        }
        const am=acceptance>0?acceptance/100:0.5;for(let i=0;i<prodScores.length;i++)prodScores[i]=Math.round(prodScores[i]*(0.5+0.5*am)*10)/10;
    }

    return {total,merged,pending,closed,draft,stale,acceptance,top_repo:topRepos.length?topRepos[0][0]:'N/A',
        yearly,monthly,daily,repo_counter:Object.fromEntries(topRepos.slice(0,15)),repo_stats:repoStats,
        type_counts:typeC,tool_counts:toolC,details,productivity:{dates:prodDates,scores:prodScores}};
}

function render(data,type){
    const nd=$('navDashboard');if(nd)nd.style.display='';
    renderProfile(data.user);renderMetrics(data.stats);renderSidebar(data.stats);
    renderProductivity(data.stats);renderStatusDonut(data.stats);renderTypeBars(data.stats);
    renderToolsDonut(data.stats);renderMonthlyTrend(data.stats);
    populateYearSelector(data.user);
    renderHeatmapGH(data.stats).catch(e=>console.warn('Heatmap error:',e));
    renderYearlyChart(data.stats);renderTopReposDetailed(data.stats);

    if(type==='deep'&&data.stats.details.length>0){
        $('prTableSection').style.display='';S.all=data.stats.details;
        populateFilters(data.stats);filterTable();
    }else $('prTableSection').style.display='none';
    window.scrollTo({top:0,behavior:'smooth'});
}

function renderProfile(u){
    $('userAvatar').src=u.avatar_url;$('userName').textContent=u.name||u.login||'--';
    $('userLogin').textContent='@'+(u.login||'--');$('userBio').textContent=u.bio||'';
    $('userLocation').innerHTML='<span class="material-symbols-outlined text-sm">location_on</span>'+(u.location||'N/A');
    $('userRepos').innerHTML='<span class="material-symbols-outlined text-sm">folder</span>'+(u.public_repos||0)+' repos';
    $('userFollowers').innerHTML='<span class="material-symbols-outlined text-sm">group</span>'+(u.followers||0)+' followers';
    $('userJoined').innerHTML='<span class="material-symbols-outlined text-sm">calendar_today</span>Joined '+(u.created_at||'N/A');
    $('userGithubLink').href=u.html_url||'#';
}

function renderMetrics(s){
    animN('metricTotal',s.total);animN('metricMerged',s.merged);animN('metricPending',s.pending);animN('metricClosed',s.closed);
    animNS($('metricAcceptance'),s.acceptance,'%');
    setTimeout(()=>{$('acceptanceBar').style.width=Math.min(s.acceptance,100)+'%';},100);
}
function animN(id,t){animNS($(id),t,'');}
function animNS(el,t,suf){if(!el)return;const d=800,st=performance.now();(function tk(n){const p=Math.min((n-st)/d,1),e=1-Math.pow(1-p,3);el.textContent=Math.round(t*e)+suf;if(p<1)requestAnimationFrame(tk);else{el.textContent=(Math.round(t*100)/100)+suf;el.classList.add('counter-pop');setTimeout(()=>el.classList.remove('counter-pop'),300);}})(st);}

function renderSidebar(s){
    const r=s.top_repo||'N/A';$('sideTopRepo').textContent=r.split('/').pop()||r;$('sideTopRepo').title=r;
    $('sideDraft').textContent=s.draft;$('sideStale').textContent=s.stale;$('sideYears').textContent=Object.keys(s.yearly).length;
}

function renderProductivity(s){
    const ctx=$('productivityCanvas');if(!ctx)return;
    const dates=s.productivity.dates||[],scores=s.productivity.scores||[];
    if(scores.length<2){ctx.parentElement.innerHTML='<div class="flex items-center justify-center h-full text-slate-500 text-sm">Insufficient data for productivity chart</div>';return;}
    const labels=dates.map(d=>{try{return new Date(d).toLocaleDateString('en',{month:'short',year:'2-digit'});}catch{return'';}});
    const pointColors=scores.map(v=>v>=50?'#10b981':'#ef4444');
    chartInstances.prod=new Chart(ctx,{
        type:'line',
        data:{labels,datasets:[
            {label:'Score',data:scores,borderWidth:2.5,pointRadius:3,pointHoverRadius:6,
                pointBackgroundColor:pointColors,pointBorderColor:pointColors,
                segment:{borderColor:c=>{const cur=c.p1.parsed.y,prev=c.p0.parsed.y;return cur>=prev?'#10b981':'#ef4444';}},
                fill:{target:{value:50},above:'rgba(16,185,129,0.08)',below:'rgba(239,68,68,0.08)'},tension:0.3},
            {label:'Baseline',data:Array(labels.length).fill(50),borderColor:'rgba(148,163,184,0.3)',borderDash:[6,4],borderWidth:1,pointRadius:0,fill:false}
        ]},
        options:{responsive:true,maintainAspectRatio:false,
            plugins:{legend:{display:false},tooltip:{backgroundColor:'#1e293b',titleColor:'#e2e8f0',bodyColor:'#94a3b8',borderColor:'#334155',borderWidth:1,cornerRadius:8}},
            scales:{y:{min:0,max:100,ticks:{color:'#64748b',callback:v=>v+'%',stepSize:25},grid:{color:'rgba(51,65,85,0.3)'}},
                x:{ticks:{color:'#64748b',maxTicksLimit:12,maxRotation:45,font:{size:10}},grid:{display:false}}},
            interaction:{intersect:false,mode:'index'}}
    });
}

function renderStatusDonut(s){
    const svg=$('statusDonut');while(svg.children.length>1)svg.removeChild(svg.lastChild);
    const total=s.merged+s.pending+s.closed;$('donutTotal').textContent=total;if(!total)return;
    const data=[{val:s.merged,color:'#10b981'},{val:s.pending,color:'#3c83f6'},{val:s.closed,color:'#94a3b8'}];
    let offset=25;
    data.forEach(d=>{if(!d.val)return;const pct=(d.val/total)*100;const c=document.createElementNS('http://www.w3.org/2000/svg','circle');
    c.setAttribute('cx','18');c.setAttribute('cy','18');c.setAttribute('r','15.915');c.setAttribute('fill','none');
    c.setAttribute('stroke',d.color);c.setAttribute('stroke-width','3.5');c.setAttribute('stroke-dasharray',pct+' '+(100-pct));
    c.setAttribute('stroke-dashoffset',String(offset));svg.appendChild(c);offset-=pct;});
}

function renderTypeBars(s){
    const c=$('typesBars');c.innerHTML='';const tc=s.type_counts||{};
    const sorted=Object.entries(tc).sort((a,b)=>b[1]-a[1]);const total=sorted.reduce((a,[,v])=>a+v,0)||1;const max=sorted.length?sorted[0][1]:1;
    sorted.forEach(([type,count])=>{const pct=Math.round((count/total)*100);const color=TYPE_COLORS[type]||'#60a5fa';
    const row=document.createElement('div');row.className='bar-row';
    row.innerHTML='<div class="bar-header"><span class="bar-label">'+esc(type)+'</span><span class="bar-value">'+count+' ('+pct+'%)</span></div><div class="bar-track"><div class="bar-fill" style="width:0%;background:'+color+'"></div></div>';
    c.appendChild(row);setTimeout(()=>{row.querySelector('.bar-fill').style.width=(count/max)*100+'%';},50);});
}

function renderToolsDonut(s){
    const svg=$('toolsDonut');const legend=$('toolsLegend');while(svg.children.length>1)svg.removeChild(svg.lastChild);legend.innerHTML='';
    const tc=s.tool_counts||{};const entries=Object.entries(tc).sort((a,b)=>b[1]-a[1]);const total=entries.reduce((a,[,v])=>a+v,0)||1;
    $('toolsDonutCenter').textContent=entries.length;let offset=0;
    entries.forEach(([tool,count],i)=>{const pct=(count/total)*100;const color=TOOL_COLORS[i%TOOL_COLORS.length];
    const c=document.createElementNS('http://www.w3.org/2000/svg','circle');c.setAttribute('cx','18');c.setAttribute('cy','18');c.setAttribute('r','16');
    c.setAttribute('fill','transparent');c.setAttribute('stroke',color);c.setAttribute('stroke-width','3.5');
    c.setAttribute('stroke-dasharray',pct+', 100');c.setAttribute('stroke-dashoffset',String(-offset));svg.appendChild(c);offset+=pct;
    const item=document.createElement('div');item.className='flex items-center gap-3';
    item.innerHTML='<div class="w-3 h-3 rounded-full flex-shrink-0" style="background:'+color+'"></div><div><p class="text-[10px] font-medium text-slate-400">'+esc(tool)+'</p><p class="text-sm font-bold">'+Math.round(pct)+'%</p></div>';
    legend.appendChild(item);});
}

function renderMonthlyTrend(s){
    const ctx=$('monthlyCanvas');if(!ctx)return;
    const mo=s.monthly||{};const months=Object.keys(mo).sort().slice(-24);if(!months.length)return;
    const vals=months.map(m=>mo[m]||0);
    const mn=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const labels=months.map(m=>{const[y,mo2]=m.split('-');return mn[parseInt(mo2)-1]+" '"+y.slice(2);});
    const colors=vals.map((v,i)=>{if(i===0)return'#10b981';return v>=vals[i-1]?'#10b981':'#ef4444';});
    chartInstances.monthly=new Chart(ctx,{
        type:'bar',
        data:{labels,datasets:[{label:'PRs',data:vals,backgroundColor:colors.map(c=>c+'30'),borderColor:colors,borderWidth:2,borderRadius:4,maxBarThickness:30}]},
        options:{responsive:true,maintainAspectRatio:false,
            plugins:{legend:{display:false},tooltip:{backgroundColor:'#1e293b',titleColor:'#e2e8f0',bodyColor:'#94a3b8',borderColor:'#334155',borderWidth:1}},
            scales:{y:{beginAtZero:true,ticks:{color:'#64748b',stepSize:1},grid:{color:'rgba(51,65,85,0.3)'}},
                x:{ticks:{color:'#64748b',maxRotation:45,font:{size:9}},grid:{display:false}}}}
    });
}

function populateYearSelector(userData) {
    const select = $('heatmapYearSelect');
    if (!select) return;
    const currentVal = select.value;
    select.innerHTML = '<option value="last">Last 12 months</option>';
    const joinYear = userData.created_at ? new Date(userData.created_at).getFullYear() : new Date().getFullYear();
    const currentYear = new Date().getFullYear();
    for (let y = currentYear; y >= joinYear; y--) {
        const opt = document.createElement('option');
        opt.value = y;
        opt.textContent = y;
        select.appendChild(opt);
    }
    if (currentVal && currentVal !== 'last') select.value = currentVal;
}

// ── GitHub-Style Heatmap — Every single day with real green dots ──
async function renderHeatmapGH(s) {
    const container = $('heatmapContainer');
    container.innerHTML = '<div class="flex items-center justify-center py-8"><div class="animate-spin w-6 h-6 border-2 border-primary border-t-transparent rounded-full"></div><span class="ml-2 text-sm text-slate-500">Loading GitHub contributions...</span></div>';

    const daily = s.daily || {};
    const yearSelect = $('heatmapYearSelect');
    const year = yearSelect ? yearSelect.value : 'last';

    // Fetch real GitHub contribution data
    let ghContribs = {};
    let fetchSuccess = false;
    let fetchError = '';

    try {
        const yearParam = year === 'last' ? '' : '&year=' + year;
        const funcUrl = '/.netlify/functions/contributions?username=' + encodeURIComponent(S.user) + yearParam;
        console.log('[Heatmap] Fetching:', funcUrl);
        const res = await fetch(funcUrl);
        const data = await res.json();

        if (res.ok && data.contributions) {
            ghContribs = data.contributions;
            const dayCount = Object.keys(ghContribs).length;
            console.log('[Heatmap] Got', dayCount, 'days, method:', data.meta ? data.meta.parseMethod : 'unknown');
            if (dayCount > 0) fetchSuccess = true;
        } else {
            fetchError = data.error || 'Unknown error';
            console.warn('[Heatmap] Error:', fetchError);
        }
    } catch (e) {
        fetchError = e.message;
        console.warn('[Heatmap] Fetch failed:', e.message);
    }

    container.innerHTML = '';

    // Determine date range
    let startDate, endDate;
    const now = new Date();
    now.setHours(0, 0, 0, 0);

    if (year === 'last') {
        endDate = new Date(now);
        startDate = new Date(now);
        startDate.setDate(startDate.getDate() - 364);
    } else {
        const y = parseInt(year);
        startDate = new Date(y, 0, 1);
        endDate = new Date(y, 11, 31);
        if (endDate > now) endDate = new Date(now);
    }

    // Adjust start to previous Sunday
    startDate.setDate(startDate.getDate() - startDate.getDay());

    // Fill ALL days in range so every cell shows
    const fillCursor = new Date(startDate);
    while (fillCursor <= endDate) {
        const key = formatDateKey(fillCursor);
        if (!ghContribs[key]) {
            ghContribs[key] = { level: 0, count: 0 };
        }
        fillCursor.setDate(fillCursor.getDate() + 1);
    }

    // Calculate total contributions in range
    let totalContribs = 0;
    for (var dateKey in ghContribs) {
        if (ghContribs.hasOwnProperty(dateKey)) {
            var dtCheck = new Date(dateKey + 'T00:00:00');
            if (dtCheck >= startDate && dtCheck <= endDate) {
                totalContribs += (ghContribs[dateKey].count || 0);
            }
        }
    }

    var totalLabel = $('heatmapTotalContrib');
    if (totalLabel) {
        if (fetchSuccess) {
            totalLabel.textContent = totalContribs.toLocaleString() + ' contributions in ' + (year === 'last' ? 'the last year' : year);
        } else {
            totalLabel.textContent = 'Contribution data unavailable';
        }
    }

    // Color scales
    var isDark = document.documentElement.classList.contains('dark');
    var greenDark = ['#161b22', '#0e4429', '#006d32', '#26a641', '#39d353'];
    var greenLight = ['#ebedf0', '#9be9a8', '#40c463', '#30a14e', '#216e39'];
    var greens = isDark ? greenDark : greenLight;
    var emptyColor = isDark ? '#161b22' : '#ebedf0';
    var orangeLevels = ['transparent', '#5a3000', '#8a5100', '#c27800', '#f59e0b'];

    // Day labels column
    var dayNames = ['', 'Mon', '', 'Wed', '', 'Fri', ''];
    var dayLabelsCol = document.createElement('div');
    dayLabelsCol.style.cssText = 'display:inline-flex;flex-direction:column;gap:3px;margin-right:4px;margin-top:20px;flex-shrink:0';
    for (var di = 0; di < dayNames.length; di++) {
        var lbl = document.createElement('div');
        lbl.className = 'gh-day-label';
        lbl.textContent = dayNames[di];
        dayLabelsCol.appendChild(lbl);
    }

    var wrapper = document.createElement('div');
    wrapper.style.cssText = 'display:flex;overflow-x:auto';
    wrapper.appendChild(dayLabelsCol);

    var grid = document.createElement('div');
    grid.className = 'gh-heatmap';

    var monthPositions = [];
    var lastMonth = -1;
    var cursor = new Date(startDate);
    var weekIndex = 0;

    // Find max PR count for orange intensity
    var prValues = Object.values(daily);
    var maxPR = prValues.length ? Math.max.apply(null, prValues.concat([1])) : 1;

    while (cursor <= endDate || cursor.getDay() !== 0) {
        if (cursor > endDate && cursor.getDay() === 0) break;

        var weekCol = document.createElement('div');
        weekCol.className = 'gh-week';

        for (var d = 0; d < 7; d++) {
            var dateStr = formatDateKey(cursor);
            var cell = document.createElement('div');
            cell.className = 'gh-cell';

            // Track months for labels
            if (cursor.getMonth() !== lastMonth) {
                if (d <= 1) {
                    monthPositions.push({ month: cursor.getMonth(), week: weekIndex });
                }
                lastMonth = cursor.getMonth();
            }

            var isFuture = cursor > now;

            if (isFuture) {
                cell.style.background = 'transparent';
                cell.style.outline = 'none';
            } else if (fetchSuccess) {
                // Real GitHub data — show exact green level
                var ghData = ghContribs[dateStr];
                var level = ghData ? Math.min(ghData.level || 0, 4) : 0;
                cell.style.background = greens[level];

                // PR activity orange dot
                var prCount = daily[dateStr] || 0;
                if (prCount > 0) {
                    var prLevel = Math.min(4, Math.ceil((prCount / maxPR) * 4));
                    var dot = document.createElement('div');
                    dot.style.cssText = 'position:absolute;top:1px;right:1px;width:4px;height:4px;border-radius:50%;background:' + orangeLevels[prLevel];
                    cell.appendChild(dot);
                }

                // Tooltip
                var ghCount = ghData ? (ghData.count || 0) : 0;
                var tipDate = cursor.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
                var tip = '';
                if (ghCount === 0) {
                    tip = 'No contributions on ' + tipDate;
                } else {
                    tip = ghCount + ' contribution' + (ghCount !== 1 ? 's' : '') + ' on ' + tipDate;
                }
                if (prCount > 0) {
                    tip += ' · ' + prCount + ' PR' + (prCount !== 1 ? 's' : '');
                }
                cell.title = tip;
            } else {
                // Fallback — show PR data only as green
                var prCountFb = daily[dateStr] || 0;
                if (prCountFb > 0) {
                    var fbLevel = Math.min(4, Math.ceil((prCountFb / maxPR) * 4));
                    cell.style.background = greens[fbLevel];
                    cell.title = prCountFb + ' PR' + (prCountFb !== 1 ? 's' : '') + ' on ' + dateStr;
                } else {
                    cell.style.background = emptyColor;
                    cell.title = 'No data for ' + dateStr;
                }
            }

            weekCol.appendChild(cell);
            cursor.setDate(cursor.getDate() + 1);
        }

        grid.appendChild(weekCol);
        weekIndex++;
    }

    wrapper.appendChild(grid);

    // Month labels
    var monthRow = document.createElement('div');
    monthRow.style.cssText = 'position:relative;height:18px;margin-left:20px;margin-bottom:2px';
    var monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    var prevLabelWeek = -4;

    for (var mi = 0; mi < monthPositions.length; mi++) {
        var mp = monthPositions[mi];
        if (mp.week - prevLabelWeek < 3) continue;
        var mlbl = document.createElement('span');
        mlbl.className = 'gh-month-label';
        mlbl.textContent = monthNames[mp.month];
        mlbl.style.cssText = 'position:absolute;left:' + (mp.week * 15) + 'px;top:0';
        monthRow.appendChild(mlbl);
        prevLabelWeek = mp.week;
    }

    container.appendChild(monthRow);
    container.appendChild(wrapper);

    // Status message if fetch failed
    if (!fetchSuccess) {
        var note = document.createElement('div');
        note.className = 'flex items-center gap-2 mt-3';
        if (Object.keys(daily).length > 0) {
            note.innerHTML = '<span class="material-symbols-outlined text-warning text-sm">warning</span><span class="text-[10px] text-warning">Could not load GitHub contributions. Showing PR activity only.</span>';
        } else {
            note.innerHTML = '<span class="material-symbols-outlined text-slate-500 text-sm">info</span><span class="text-[10px] text-slate-500">No contribution data available.</span>';
        }
        container.appendChild(note);
    }
}

function renderYearlyChart(s){
    const ctx=$('yearlyCanvas');if(!ctx)return;
    const yr=s.yearly||{};const years=Object.keys(yr).sort();if(!years.length)return;
    const vals=years.map(y=>yr[y]||0);
    const colors=['#6366f1','#a78bfa','#3c83f6','#10b981','#f59e0b','#f97316','#ef4444','#ec4899'];
    chartInstances.yearly=new Chart(ctx,{
        type:'bar',
        data:{labels:years,datasets:[{label:'PRs',data:vals,backgroundColor:vals.map((_,i)=>colors[i%colors.length]+'90'),
            borderColor:vals.map((_,i)=>colors[i%colors.length]),borderWidth:2,borderRadius:6,maxBarThickness:60}]},
        options:{responsive:true,maintainAspectRatio:false,
            plugins:{legend:{display:false},tooltip:{backgroundColor:'#1e293b',titleColor:'#e2e8f0',bodyColor:'#94a3b8'}},
            scales:{y:{beginAtZero:true,ticks:{color:'#64748b',stepSize:Math.max(1,Math.ceil(Math.max.apply(null,vals)/5))},grid:{color:'rgba(51,65,85,0.3)'}},
                x:{ticks:{color:'#94a3b8',font:{size:13,weight:'600'}},grid:{display:false}}}}
    });
}

function renderTopReposDetailed(s){
    const c=$('topReposDetailed');c.innerHTML='';
    const rc=s.repo_counter||{};const rs=s.repo_stats||{};
    const sorted=Object.entries(rc).sort((a,b)=>b[1]-a[1]).slice(0,8);
    const medals=['🥇','🥈','🥉','4','5','6','7','8'];

    sorted.forEach(([repo,count],i)=>{
        const name=repo.split('/').pop();const full=repo;
        const st=rs[repo]||{total:count,merged:0,pending:0,closed:0};
        const mPct=st.total>0?Math.round((st.merged/st.total)*100):0;

        const card=document.createElement('div');card.className='repo-detail-card';
        card.innerHTML='<div class="flex items-start justify-between mb-3"><div class="flex items-center gap-3"><span class="text-lg">'+(medals[i]||'')+'</span><div><p class="font-bold text-sm" title="'+esc(full)+'">'+esc(name.length>30?name.slice(0,27)+'...':name)+'</p><p class="text-[11px] text-slate-500 font-mono">'+esc(full)+'</p></div></div><span class="text-lg font-black text-primary pr-2">'+count+'</span></div><div class="flex gap-3 mb-3 text-[11px]"><span class="flex items-center gap-1 text-success"><span class="material-symbols-outlined text-[14px]">call_merge</span>'+st.merged+' merged</span><span class="flex items-center gap-1 text-primary"><span class="material-symbols-outlined text-[14px]">schedule</span>'+st.pending+' open</span><span class="flex items-center gap-1 text-slate-400"><span class="material-symbols-outlined text-[14px]">close</span>'+st.closed+' closed</span></div><div class="h-1.5 w-full bg-slate-700 rounded-full overflow-hidden"><div class="h-full bg-success rounded-full transition-all duration-1000" style="width:0%"></div></div><p class="text-[10px] text-slate-500 mt-1">'+mPct+'% merge rate</p>';
        c.appendChild(card);
        setTimeout(()=>{card.querySelector('.bg-success').style.width=mPct+'%';},50+i*60);
    });
}

function populateFilters(s){
    const ts=$('tblFilterType');ts.innerHTML='<option value="all">All Types</option>';
    Object.keys(s.type_counts||{}).sort().forEach(t=>{const o=document.createElement('option');o.value=t;o.textContent=t;ts.appendChild(o);});
    const rs=$('tblFilterRepo');if(rs){rs.innerHTML='<option value="all">All Repos</option>';
    Object.keys(s.repo_counter||{}).sort().forEach(r=>{const o=document.createElement('option');o.value=r;const name=r.split('/').pop();o.textContent=name.length>25?name.slice(0,22)+'...':name;rs.appendChild(o);});}
    const dl=$('prSuggestions');if(dl){dl.innerHTML='';
    (s.details||[]).slice(0,100).forEach(pr=>{const o=document.createElement('option');o.value='#'+pr.number+' '+pr.title;dl.appendChild(o);});}
}

function filterTable(){
    const sv=$('tblFilterStatus')?$('tblFilterStatus').value:'all';
    const tv=$('tblFilterType')?$('tblFilterType').value:'all';
    const rv=$('tblFilterRepo')?$('tblFilterRepo').value:'all';
    const st=$('tblSearch')?$('tblSearch').value.toLowerCase():'';
    let f=[...S.all];
    if(sv!=='all')f=f.filter(p=>p.status===sv);
    if(tv!=='all')f=f.filter(p=>p.type===tv);
    if(rv!=='all')f=f.filter(p=>p.repo===rv);
    if(st)f=f.filter(p=>(p.title||'').toLowerCase().includes(st)||(p.repo||'').toLowerCase().includes(st)||('#'+p.number).includes(st));
    S.filtered=f;S.page=1;renderTablePage();
}

function renderTablePage(){
    const tbody=$('prTableBody');tbody.innerHTML='';
    const d=S.filtered,tp=Math.max(1,Math.ceil(d.length/PAGE_SIZE)),pg=S.page;
    const slice=d.slice((pg-1)*PAGE_SIZE,pg*PAGE_SIZE);

    if(!slice.length){tbody.innerHTML='<tr><td colspan="6" class="px-5 py-10 text-center text-slate-500">No PRs match your filters</td></tr>';
    }else{
        slice.forEach(pr=>{
            const tr=document.createElement('tr');tr.className='hover:bg-slate-50 dark:hover:bg-slate-900/30 transition-colors';
            let sc='status-closed',st='Closed',icon='close';
            if(pr.status==='merged'){sc='status-merged';st='Merged';icon='call_merge';}
            else if(pr.status==='open'){sc='status-open';st='Open';icon='adjust';}
            const tc=TYPE_COLORS[pr.type]||'#60a5fa';
            let toolIcon='language';if((pr.tool||'').includes('CLI'))toolIcon='terminal';else if((pr.tool||'').toLowerCase().includes('bot'))toolIcon='robot_2';else if((pr.tool||'').includes('Action'))toolIcon='settings';
            const title=(pr.title||'').length>50?pr.title.slice(0,47)+'...':pr.title;
            const repoName=(pr.repo||'').split('/').pop();
            tr.innerHTML='<td class="px-5 py-4"><div class="font-semibold text-sm">'+esc(title)+'</div><div class="text-xs text-slate-500">#'+pr.number+' · '+esc(repoName)+'</div></td><td class="px-5 py-4"><span class="status-pill '+sc+'"><span class="material-symbols-outlined text-[14px]">'+icon+'</span>'+st+'</span></td><td class="px-5 py-4"><span class="type-chip" style="background:'+tc+'15;color:'+tc+';border-color:'+tc+'30">'+esc(pr.type||'General')+'</span></td><td class="px-5 py-4"><div class="flex items-center gap-1.5 text-sm text-slate-400"><span class="material-symbols-outlined text-sm">'+toolIcon+'</span>'+esc(pr.tool||'')+'</div></td><td class="px-5 py-4 text-sm text-slate-500 whitespace-nowrap">'+(pr.created_at||'')+'</td><td class="px-5 py-4 text-right"><a href="'+(pr.url||'#')+'" target="_blank" rel="noopener" class="text-primary hover:underline text-sm font-semibold">View</a></td>';
            tbody.appendChild(tr);
        });
    }
    $('tblInfo').textContent='Showing '+(slice.length?((pg-1)*PAGE_SIZE+1):0)+'-'+Math.min(pg*PAGE_SIZE,d.length)+' of '+d.length;
    $('tblPrev').disabled=pg<=1;$('tblNext').disabled=pg>=tp;
}

function tblPage(delta){const tp=Math.max(1,Math.ceil(S.filtered.length/PAGE_SIZE));const np=S.page+delta;if(np>=1&&np<=tp){S.page=np;renderTablePage();}}

function exJSON(){if(!S.data)return;dl(new Blob([JSON.stringify(S.data,null,2)],{type:'application/json'}),S.user+'_report.json');}
function exCSV(){if(!S.data)return;const det=S.data.stats.details||[];const hd='Status,Number,Repository,Title,Type,Tool,Date,URL\n';
const rows=det.map(p=>[p.status,p.number,p.repo,'"'+(p.title||'').replace(/"/g,'""')+'"',p.type,p.tool,p.created_at,p.url].join(',')).join('\n');
dl(new Blob([hd+rows],{type:'text/csv'}),S.user+'_report.csv');}
function exMD(){if(!S.data)return;const s=S.data.stats,u=S.data.user;
let md='# PR Report: @'+(u.login||S.user)+'\n\n**Generated:** '+new Date().toISOString().slice(0,19)+'\n\n---\n\n';
md+='## Summary\n| Metric | Value |\n|---|---|\n| Total | '+s.total+' |\n| Merged | '+s.merged+' |\n| Pending | '+s.pending+' |\n| Closed | '+s.closed+' |\n| Acceptance | '+s.acceptance+'% |\n\n';
if(s.type_counts){md+='## Types\n| Type | Count |\n|---|---|\n';Object.entries(s.type_counts).sort((a,b)=>b[1]-a[1]).forEach(([t,c])=>md+='| '+t+' | '+c+' |\n');md+='\n';}
md+='---\n*Generated by PREXEC*\n';dl(new Blob([md],{type:'text/markdown'}),S.user+'_report.md');}
function dl(blob,name){const u=URL.createObjectURL(blob);const a=document.createElement('a');a.href=u;a.download=name;document.body.appendChild(a);a.click();setTimeout(()=>{document.body.removeChild(a);URL.revokeObjectURL(u);},100);}

function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
function esc(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML;}