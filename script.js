if ('scrollRestoration' in history) {
  history.scrollRestoration = 'manual';
}

const $ = s => document.querySelector(s);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cmToIn = v => (v || 0) / 2.54;
const sum = (arr, a, b) => arr.slice(Math.max(0, a), b + 1).reduce((s, v) => s + (v || 0), 0);
const iso = d => d.toISOString().slice(0, 10);

let currentSeasons = [];
let initialData = null; 

let bootDone = false;
const bootBar = $('#bootBar');
const bootPct = $('#bootPct');
const bootPress = $('#bootPress');

// Lock body scroll physically
document.body.style.overflow = 'hidden';
document.documentElement.style.overflow = 'hidden';

let saved = 'Bozeman';
try { saved = localStorage.getItem('ws-last') || 'Bozeman'; } catch(e) {}
initialData = fetchData(saved); 

function startBoot() {
  let progress = 0;
  const interval = setInterval(() => {
    progress += Math.random() * 5 + 2;
    if (progress > 100) progress = 100;
    bootBar.style.width = progress + '%';
    bootPct.textContent = Math.round(progress) + '%';
    
    if (progress >= 100) {
      clearInterval(interval);
      bootPress.style.display = 'block';
      bootPress.style.opacity = '1';
    }
  }, 80);
}

function finishBoot(e) {
  if (bootDone) return;
  
  // Stop spacebar/arrows from scrolling the page before we hide the overlay
  if (e) {
    e.preventDefault();
  }
  
  bootDone = true;
  
  // 1. Hide the boot screen
  $('#boot').classList.add('hidden');
  
  // 2. Enable scrolling completely
  document.body.style.overflow = '';
  document.documentElement.style.overflow = '';
  document.body.classList.add('loaded');
  
  // 3. Hard scroll to top AFTER unlocking overflow
  window.scrollTo(0, 0);
  setTimeout(() => window.scrollTo(0, 0), 10);
  setTimeout(() => window.scrollTo(0, 0), 100);

  // 4. Fade out the boot screen from DOM
  setTimeout(() => { 
    $('#boot').style.display = 'none'; 
  }, 600);

  // 5. Handle data loading state
  document.body.classList.add('is-loading');
  $('#locName').textContent = 'FETCHING TELEMETRY...';

  // 6. Resolve and render
  initialData.then(data => {
    render(data.loc, data.f, data.hist, data.area);
    document.body.classList.remove('is-loading');
  }).catch(e => {
    console.error("Initial fetch failed", e);
    $('#locName').textContent = 'CONNECTION FAILED';
    $('#tickerText').innerHTML = '<span class="ticker-item alert">CONNECTION FAILED // RETRY QUERY</span>';
    document.body.classList.remove('is-loading');
  });
  
  // 7. Remove listeners to prevent future interference
  document.removeEventListener('keydown', finishBoot);
  document.removeEventListener('touchstart', finishBoot);
}

bootPress.addEventListener('click', finishBoot);
document.addEventListener('keydown', finishBoot);
document.addEventListener('touchstart', finishBoot);

setTimeout(startBoot, 500);

async function geocode(name) {
  const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=en&format=json`);
  if (!r.ok) throw new Error('GEOCODE FAILED');
  const d = await r.json();
  if (!d.results?.length) throw new Error('LOCATION NOT FOUND');
  const g = d.results[0];
  return { name: g.name, region: [g.admin1, g.country_code].filter(Boolean).join(', '), lat: g.latitude, lon: g.longitude };
}

async function getForecast(lat, lon) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,apparent_temperature,wind_speed_10m` +
    `&hourly=snowfall,snow_depth&daily=precipitation_probability_max` +
    `&past_days=2&forecast_days=7&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('FORECAST FAILED');
  return r.json();
}

async function getHistory(lat, lon) {
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 7);
  const seasonStart = cutoff.getMonth() >= 6 ? cutoff.getFullYear() : cutoff.getFullYear() - 1;
  const earliest = `${seasonStart - 5}-10-01`;
  const r = await fetch(`https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}` +
    `&start_date=${earliest}&end_date=${iso(cutoff)}&daily=snowfall_sum&timezone=auto`);
  if (!r.ok) throw new Error('ARCHIVE FAILED');
  const d = await r.json();
  const seasons = [];
  for (let y = 5; y >= 0; y--) {
    const sy = seasonStart - y;
    const start = `${sy}-10-01`;
    const end = iso(new Date(cutoff.getFullYear() - y, cutoff.getMonth(), cutoff.getDate()));
    let total = 0;
    d.daily.time.forEach((t, i) => { if (t >= start && t <= end) total += d.daily.snowfall_sum[i] || 0; });
    seasons.push({ label: `${sy}–${String(sy + 1).slice(2)}`, value: cmToIn(total), current: y === 0 });
  }
  return { seasons, cutoff };
}

async function getArea(lat, lon) {
  const dLat = 0.36, dLon = 0.36 / Math.cos(lat * Math.PI / 180);
  const pts = [['NORTH', lat + dLat, lon], ['EAST', lat, lon + dLon], ['SOUTH', lat - dLat, lon], ['WEST', lat, lon - dLon]];
  const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${pts.map(p => p[1].toFixed(3))}` +
    `&longitude=${pts.map(p => p[2].toFixed(3))}&current=temperature_2m&hourly=snowfall&past_days=1&forecast_days=1&timezone=auto`);
  if (!r.ok) throw new Error('AREA FAILED');
  const d = await r.json();
  const list = Array.isArray(d) ? d : [d];
  return list.map((loc, i) => {
    const idx = hourIndex(loc);
    return { name: pts[i][0], rate: cmToIn(loc.hourly.snowfall[idx]), day: cmToIn(sum(loc.hourly.snowfall, idx - 23, idx)) };
  });
}

async function fetchData(query) {
  const loc = await geocode(query);
  const fP = getForecast(loc.lat, loc.lon);
  const hP = getHistory(loc.lat, loc.lon);
  const aP = getArea(loc.lat, loc.lon);
  const f = await fP;
  const [hist, area] = await Promise.all([hP, aP]);
  return { loc, f, hist, area };
}

function hourIndex(d) {
  if (!d.current || !d.hourly) return 24;
  const key = d.current.time.slice(0, 13) + ':00';
  const i = d.hourly.time.indexOf(key);
  return i >= 0 ? i : 24 * 2 + new Date().getHours();
}

function riskLevel({ temp, chill, wind, rate, depth }) {
  let s = 0;
  let factors = {
    temp: false, chill: false, rate: false, heavy: false, wind: false, depth: false
  };

  if (temp <= 32) { s++; factors.temp = true; }
  if (chill <= 15) { s++; factors.chill = true; }
  if (rate > 0) { s++; factors.rate = true; }
  if (rate > 0.3) { s += 2; factors.heavy = true; }
  if (wind > 15) { s++; factors.wind = true; }
  if (depth > 1) { s++; factors.depth = true; }

  let level = 'LOW', color = 'blue';
  if (s >= 5) { level = 'SEVERE'; color = 'warn'; }
  else if (s >= 3) { level = 'MODERATE'; color = 'yellow'; }

  return { level, color, factors, score: s };
}

function probability(total, threshold, precipMax) {
  const p = (precipMax || 0) / 100;
  const ratio = Math.min(total / threshold, 1);
  return Math.round(100 * (total >= threshold ? Math.max(p, 0.6) : p * ratio * ratio));
}

function countUp(el, to, dec = 1) {
  const start = performance.now(), dur = 900;
  const step = now => {
    const t = Math.min((now - start) / dur, 1), e = 1 - Math.pow(1 - t, 3);
    el.textContent = (to * e).toFixed(dec);
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function renderChart(hourly, idx) {
  const vals = [];
  for (let i = idx - 12; i <= idx + 12; i++) vals.push(cmToIn(hourly.snowfall[i]));
  
  const max = Math.max(...vals, 1.0); 
  
  if (max <= 0.2 && Math.max(...vals) <= 0.2) {
    $('#empty-chart').style.display = 'flex';
    $('#chart-line-path').setAttribute('d', '');
    $('#chart-fill-path').setAttribute('d', '');
    $('#chart-point').style.display = 'none';
    return;
  } else {
    $('#empty-chart').style.display = 'none';
  }

  const points = vals.map((v, n) => {
    const x = (n / 24) * 100;
    const y = 100 - (v / max) * 80 - 10;
    return {x, y};
  });

  const pathStr = points.map((p, i) => (i === 0 ? 'M' : 'L') + p.x.toFixed(1) + ',' + p.y.toFixed(1)).join(' ');
  const fillStr = pathStr + ` L100,100 L0,100 Z`;

  $('#chart-line-path').setAttribute('d', pathStr);
  $('#chart-fill-path').setAttribute('d', fillStr);

  const pt = points[12];
  const circle = $('#chart-point');
  circle.setAttribute('cx', pt.x);
  circle.setAttribute('cy', pt.y);
  circle.style.display = 'block';
}

function renderTimeline(hourly, idx) {
  const box = $('#hourly'); box.innerHTML = '';
  const vals = [];
  for (let i = idx; i <= idx + 11; i++) vals.push(cmToIn(hourly.snowfall[i]));
  
  vals.forEach((v, n) => {
    const off = n;
    
    let iconSvg = '';
    if (v > 0.3) iconSvg = '<svg viewBox="0 0 24 24" width="22" height="22" stroke="currentColor" stroke-width="1.4" fill="none"><line x1="12" y1="2" x2="12" y2="22"/><line x1="3.5" y1="7" x2="20.5" y2="17"/><line x1="3.5" y1="17" x2="20.5" y2="7"/></svg>';
    else if (v > 0) iconSvg = '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M18 9h-1.26A8 8 0 1 0 9 19h9a5 5 0 0 0 0-10z" opacity="0.7"/><circle cx="8" cy="21" r="0.9"/><circle cx="12" cy="22" r="0.9"/><circle cx="16" cy="21" r="0.9"/></svg>';
    else iconSvg = '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>';

    const tLab = off === 0 ? 'NOW' : '+' + off + 'H';
    const intensityClass = v > 0.3 ? 'hv' : v > 0 ? 'md' : 'lt';
    const intensityText = v > 0.3 ? 'HEAVY' : v > 0 ? 'MOD' : 'LIGHT';

    const col = document.createElement('div');
    col.className = 'hour' + (off === 0 ? ' now' : '');
    col.innerHTML = `
      <div class="t">${tLab}</div>
      <div class="node"></div>
      <div class="i">${iconSvg}</div>
      <div class="amt">${v.toFixed(1)}<small>″</small></div>
      <div class="intensity ${intensityClass}">${intensityText}</div>
    `;
    box.appendChild(col);
  });
}

function renderProbs(total, precipMax) {
  $('#probs').innerHTML = [1, 3, 6].map(t => {
    const p = probability(total, t, precipMax);
    return `<div class="prob"><div class="top"><span>${t}+ IN</span><span>${p}%</span></div><div class="bar"><i data-w="${p}"></i></div></div>`;
  }).join('');
  setTimeout(() => document.querySelectorAll('.bar i').forEach(b => b.style.width = b.dataset.w + '%'), 100);
}

function renderHistory(seasons) {
  currentSeasons = seasons;
  const c = $('#hist'), dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth, h = c.clientHeight;
  if (w === 0) return;
  c.width = w * dpr; c.height = h * dpr;
  const ctx = c.getContext('2d'); ctx.scale(dpr, dpr); ctx.clearRect(0, 0, w, h);
  const max = Math.max(...seasons.map(s => s.value), 1) * 1.15;
  const pad = 32, bw = (w - pad * 2) / seasons.length;
  const past = seasons.filter(s => !s.current);
  const avg = past.reduce((a, s) => a + s.value, 0) / past.length;

  ctx.font = '10px ui-monospace'; ctx.textAlign = 'center';
  seasons.forEach((s, i) => {
    const bh = (s.value / max) * (h - 60);
    const x = pad + i * bw + bw * 0.15, y = h - 30 - bh;
    ctx.fillStyle = s.current ? '#00a8ff' : '#b0bcc6';
    ctx.fillRect(x, y, bw * 0.7, bh);
    ctx.fillStyle = s.current ? '#00a8ff' : '#6a7580';
    ctx.fillText(s.value.toFixed(1), x + bw * 0.35, y - 8);
    ctx.fillText(s.label, x + bw * 0.35, h - 10);
  });
  const ay = h - 30 - (avg / max) * (h - 60);
  ctx.strokeStyle = '#d12828'; ctx.setLineDash([4, 4]); ctx.beginPath();
  ctx.moveTo(pad, ay); ctx.lineTo(w - pad, ay); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = '#d12828'; ctx.textAlign = 'left'; ctx.fillText(`AVG ${avg.toFixed(1)}`, pad, ay - 6);

  const cur = seasons[seasons.length - 1].value;
  const diff = avg ? Math.round(((cur - avg) / avg) * 100) : 0;
  $('#histNote').textContent = `CURRENT SEASON ${diff >= 0 ? '+' : ''}${diff}% VS 5-SEASON AVERAGE`;
}

async function manualScan(query) {
  const btn = $('#scanBtn');
  const input = $('#city');
  
  document.body.classList.add('is-loading');
  btn.disabled = true;
  btn.textContent = 'FETCHING...';
  input.disabled = true;
  $('#locName').textContent = 'FETCHING TELEMETRY...';

  try {
    const data = await fetchData(query);
    render(data.loc, data.f, data.hist, data.area);
    input.value = '';
  } catch (e) {
    $('#locName').textContent = 'CONNECTION FAILED';
    $('#tickerText').innerHTML = '<span class="ticker-item alert">CONNECTION FAILED // RETRY QUERY</span>';
  }
  
  document.body.classList.remove('is-loading');
  btn.disabled = false;
  btn.textContent = 'SCAN';
  input.disabled = false;
}

function render(loc, f, hist, area) {
  const idx = hourIndex(f), H = f.hourly;
  const depth = (H.snow_depth[idx] || 0) * 39.37;
  const rate = cmToIn(H.snowfall[idx]);
  const t24 = cmToIn(sum(H.snowfall, idx - 23, idx));
  const t48 = cmToIn(sum(H.snowfall, idx - 47, idx));
  const n72 = cmToIn(sum(H.snowfall, idx + 1, idx + 72));
  const c = f.current;
  const precipMax = Math.max(...f.daily.precipitation_probability_max.slice(2, 5).map(v => v || 0));

  $('#locName').textContent = `${loc.name.toUpperCase()}, ${loc.region.toUpperCase()}`;
  countUp($('#depth'), depth);
  countUp($('#t24'), t24); countUp($('#t48'), t48); countUp($('#n72'), n72);
  countUp($('#season'), hist.seasons[hist.seasons.length - 1].value);
  
  $('#rate').textContent = `${rate.toFixed(2)} IN/HR`;
  $('#temp').textContent = `${Math.round(c.temperature_2m)}°F`;
  $('#chill').textContent = `${Math.round(c.apparent_temperature)}°F`;
  $('#wind').textContent = `${Math.round(c.wind_speed_10m)} MPH`;

  renderProbs(n72, precipMax);
  renderTimeline(H, idx);
  renderChart(H, idx);
  renderHistory(hist.seasons);
  
  $('#area').innerHTML = area.map(a => `
    <tr>
      <td class="loc">${a.name}<span class="sub">SECTOR</span></td>
      <td class="bar-cell"></td>
      <td class="rate-val">${a.rate.toFixed(2)}<span class="u">″/H</span></td>
      <td class="total">${a.day.toFixed(1)}″</td>
    </tr>
  `).join('');

  const risk = riskLevel({ temp: c.temperature_2m, chill: c.apparent_temperature, wind: c.wind_speed_10m, rate, depth });
  
  let tickerClass = 'ok';
  if (risk.level === 'MODERATE') tickerClass = 'warn';
  if (risk.level === 'SEVERE') tickerClass = 'alert';
  
  const tickerStr = `
    <span class="ticker-item ${tickerClass}">[ STATUS: ${risk.level} ]</span>
    <span class="ticker-item">TEMP: ${Math.round(c.temperature_2m)}°F</span>
    <span class="ticker-item">WIND: ${Math.round(c.wind_speed_10m)} MPH</span>
    <span class="ticker-item">SNOW: ${rate.toFixed(2)} IN/HR</span>
    <span class="ticker-item">ACCUMULATION: ${depth.toFixed(1)} IN</span>
    <span class="ticker-item">///</span>
  `;
  
  $('#tickerText').innerHTML = tickerStr + tickerStr;

  document.querySelectorAll('.rows div').forEach(r => r.className = '');
  if (risk.factors.rate || risk.factors.heavy) $('#row-rate').className = 'highlight-' + risk.color;
  if (risk.factors.temp) $('#row-temp').className = 'highlight-' + risk.color;
  if (risk.factors.chill) $('#row-chill').className = 'highlight-' + risk.color;
  if (risk.factors.wind) $('#row-wind').className = 'highlight-' + risk.color;

  $('#date').textContent = new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'}).toUpperCase() + ' // ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  $('#footstamp').textContent = new Date().getFullYear()+'.'+(new Date().getMonth()+1)+'.'+new Date().getDate();
}

$('#scanBtn').addEventListener('click', () => {
  const q = $('#city').value.trim();
  if (q) manualScan(q);
  else manualScan('Bozeman');
});

$('#city').addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    $('#scanBtn').click();
  }
});

window.addEventListener('resize', () => {
  if (currentSeasons.length > 0) renderHistory(currentSeasons);
});

(function(){
  var TONES=[['#bcc5cd','#a0abb5'],['#a3aeb8','#8996a1'],['#9ba6b1','#8794a1']];
  function defs(){
    var o='<defs>';
    TONES.forEach(function(t,ti){[0,1].forEach(function(di){
      var c=di===0?['0%','0%','100%','100%']:['100%','0%','0%','100%'];
      o+='<linearGradient id="g'+ti+di+'" x1="'+c[0]+'" y1="'+c[1]+'" x2="'+c[2]+'" y2="'+c[3]+'"><stop offset="0%" stop-color="'+t[0]+'"/><stop offset="100%" stop-color="'+t[1]+'"/></linearGradient>';
    });});
    return o+'</defs>';
  }
  function build(){
    var svg=document.getElementById('tris-svg');if(!svg)return;
    var vw=window.innerWidth,vh=window.innerHeight,m=vw<768;
    var W=vw/(m?3.5:6.5),H=W*0.866,PAD=3;
    var cols=Math.ceil(vw/(W/2))+4,rows=Math.ceil(vh/H)+3,out=[];
    for(var r=-1;r<=rows;r++){for(var c=-2;c<=cols;c++){
      var l=c*(W/2),t=r*H,up=(c+r)%2===0,d=up?0:1;
      var p=up?(l+W/2)+','+(t-PAD)+' '+(l-PAD)+','+(t+H+PAD)+' '+(l+W+PAD)+','+(t+H+PAD)
             :(l-PAD)+','+(t-PAD)+' '+(l+W+PAD)+','+(t-PAD)+' '+(l+W/2)+','+(t+H+PAD);
      var bd=-(Math.abs(r*0.83+c*0.61)%15),cell='';
      for(var k=0;k<3;k++){cell+='<polygon class="tri" points="'+p+'" fill="url(#g'+k+d+')" style="animation-delay:'+(bd-k*5).toFixed(2)+'s"/>';}
      out.push(cell);
    }}
    svg.innerHTML=defs()+'<rect width="100%" height="100%" fill="var(--bg)"/><g>'+out.join('')+'</g>';
    svg.setAttribute('viewBox','0 0 '+vw+' '+vh);
    svg.setAttribute('preserveAspectRatio','none');
    svg.setAttribute('shape-rendering','auto');
  }
  build();
  var t;window.addEventListener('resize',function(){clearTimeout(t);t=setTimeout(build,200)});
})();

(function(){
  var t=null;
  window.addEventListener('scroll',function(){
    if(!isScrolling){document.body.classList.add('is-scrolling');isScrolling=true;}
    clearTimeout(t);
    t=setTimeout(function(){document.body.classList.remove('is-scrolling');isScrolling=false;},140);
  },{passive:true});
})();
