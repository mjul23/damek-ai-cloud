#!/usr/bin/env node
// 🤖 SERVEUR CLOUD - IA DÄMEK TRAINING + ANALYSE GRAPHIQUES
// Affiche les résultats directement sans télécharger!

const express = require('express');
const fs = require('fs');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

console.log(`\n📡 Port utilisé: ${PORT}\n`);

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const TYPES = ['PION', 'CAVALIER', 'FOU', 'TOUR', 'ROI', 'DAME'];
const LEARNING_RATE = 0.15;
const EPSILON_DECAY = 0.993;

let trainingStatus = { running: false, episode: 0, totalEpisodes: 0, winRate: 0, states: 0, epsilon: 1.0, startTime: null, history: [] };
let trainingInProgress = false;

const MOVES = {
  PION: (r, c, p, b) => { const m = []; const [dr, dc] = p === 0 ? [1, 1] : [-1, -1]; if (r + dr >= 0 && r + dr < 8 && c + dc >= 0 && c + dc < 8 && !b[r + dr][c + dc]) { m.push({ to: [r + dr, c + dc], cap: false }); } const caps = p === 0 ? [[1,0],[0,1]] : [[-1,0],[0,-1]]; caps.forEach(([cr, cc]) => { const nr = r + cr, nc = c + cc; if (nr >= 0 && nr < 8 && nc >= 0 && nc < 8 && b[nr][nc] && b[nr][nc].p !== p) { m.push({ to: [nr, nc], cap: true, target: b[nr][nc] }); } }); return m; },
  CAVALIER: (r, c, p, b) => { const m = []; [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]].forEach(([dr,dc]) => { const nr = r+dr, nc = c+dc; if (nr >= 0 && nr < 8 && nc >= 0 && nc < 8) { if (!b[nr][nc]) m.push({ to: [nr, nc], cap: false }); else if (b[nr][nc].p !== p) m.push({ to: [nr, nc], cap: true, target: b[nr][nc] }); } }); return m; },
  FOU: (r, c, p, b) => { const m = []; [[-1,-1],[-1,1],[1,-1],[1,1]].forEach(([dr,dc]) => { for (let i = 1; i <= 8; i++) { const nr = r+dr*i, nc = c+dc*i; if (nr < 0 || nr >= 8 || nc < 0 || nc >= 8) break; if (!b[nr][nc]) m.push({ to: [nr, nc], cap: false }); else { if (b[nr][nc].p !== p) m.push({ to: [nr, nc], cap: true, target: b[nr][nc] }); break; } } }); return m; },
  TOUR: (r, c, p, b) => { const m = []; [[-1,0],[1,0],[0,-1],[0,1]].forEach(([dr,dc]) => { for (let i = 1; i <= 8; i++) { const nr = r+dr*i, nc = c+dc*i; if (nr < 0 || nr >= 8 || nc < 0 || nc >= 8) break; if (!b[nr][nc]) m.push({ to: [nr, nc], cap: false }); else { if (b[nr][nc].p !== p) m.push({ to: [nr, nc], cap: true, target: b[nr][nc] }); break; } } }); return m; },
  ROI: (r, c, p, b) => { const m = []; [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]].forEach(([dr,dc]) => { const nr = r+dr, nc = c+dc; if (nr >= 0 && nr < 8 && nc >= 0 && nc < 8) { if (!b[nr][nc]) m.push({ to: [nr, nc], cap: false }); else if (b[nr][nc].p !== p) m.push({ to: [nr, nc], cap: true, target: b[nr][nc] }); } }); return m; },
  DAME: (r, c, p, b) => { const m = []; [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]].forEach(([dr,dc]) => { for (let i = 1; i <= 8; i++) { const nr = r+dr*i, nc = c+dc*i; if (nr < 0 || nr >= 8 || nc < 0 || nc >= 8) break; if (!b[nr][nc]) m.push({ to: [nr, nc], cap: false }); else { if (b[nr][nc].p !== p) m.push({ to: [nr, nc], cap: true, target: b[nr][nc] }); break; } } }); return m; }
};

function createBoard() { const b = []; for (let r = 0; r < 8; r++) { b[r] = []; for (let c = 0; c < 8; c++) b[r][c] = null; } [[0,0],[0,1],[1,0],[0,2],[1,1],[2,0],[0,3],[1,2],[2,1],[3,0]].forEach(([r,c], i) => { b[r][c] = { p: 0, spy: i === 0 }; }); [[7,7],[7,6],[6,7],[7,5],[6,6],[5,7],[7,4],[6,5],[5,6],[4,7]].forEach(([r,c], i) => { b[r][c] = { p: 1, spy: i === 0 }; }); return b; }

function getAllMoves(player, type, board) { const all = []; for (let r = 0; r < 8; r++) { for (let c = 0; c < 8; c++) { if (board[r][c]?.p === player) { MOVES[type](r, c, player, board).forEach(m => all.push({ from: [r, c], ...m })); } } } return all; }

function executeMove(board, from, to) { const newBoard = board.map(row => [...row]); newBoard[to[0]][to[1]] = newBoard[from[0]][from[1]]; const captured = board[to[0]][to[1]]; newBoard[from[0]][from[1]] = null; return { board: newBoard, captured }; }

class DamekAI {
  constructor(player = 0) { this.player = player; this.qTable = {}; this.alpha = LEARNING_RATE; this.gamma = 0.95; this.epsilon = 1.0; }
  getBoardHash(board) { let hash = ''; for (let r = 0; r < 8; r++) { for (let c = 0; c < 8; c++) { const p = board[r][c]; hash += p ? `${p.p}${p.spy ? 'S' : ''}` : '.'; } } return hash; }
  chooseAction(board, moves) { if (!moves.length) return null; if (Math.random() < this.epsilon) { return moves[Math.floor(Math.random() * moves.length)]; } const state = this.getBoardHash(board); let bestMove = moves[0]; let bestQ = -Infinity; for (let move of moves) { const key = `${state}:${move.from[0]},${move.from[1]},${move.to[0]},${move.to[1]}`; const q = this.qTable[key] || 0; if (q > bestQ) { bestQ = q; bestMove = move; } } return bestMove; }
  learn(stateBefore, move, reward, stateAfter) { const key = `${stateBefore}:${move.from[0]},${move.from[1]},${move.to[0]},${move.to[1]}`; const currentQ = this.qTable[key] || 0; let maxQ = 0; for (let k in this.qTable) { if (k.startsWith(stateAfter + ':')) { maxQ = Math.max(maxQ, this.qTable[k]); } } const newQ = currentQ + this.alpha * (reward + this.gamma * maxQ - currentQ); this.qTable[key] = newQ; }
  decayEpsilon() { this.epsilon *= EPSILON_DECAY; }
  toJSON() { return JSON.stringify(this.qTable); }
  fromJSON(json) { try { this.qTable = JSON.parse(json); } catch (e) { this.qTable = {}; } }
  cleanup() { const threshold = 0.01; const keys = Object.keys(this.qTable); for (let key of keys) { if (Math.abs(this.qTable[key]) < threshold) { delete this.qTable[key]; } } }
}

function playGame(ai1, ai2, timeout = 5000) {
  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => resolve({ winner: 0, wins: [0, 0] }), timeout);
    try {
      let board = createBoard(); let turn = 0; let roundNum = 0; let wins = [0, 0];
      while (wins[0] < 3 && wins[1] < 3 && roundNum < 50) {
        roundNum++; turn = 0;
        while (turn < 100) {
          const dice = TYPES[Math.floor(Math.random() * 6)]; const ai = turn === 0 ? ai1 : ai2; const moves = getAllMoves(turn, dice, board);
          if (!moves.length) break;
          const stateBefore = ai.getBoardHash(board); const move = ai.chooseAction(board, moves);
          if (!move) break;
          const result = executeMove(board, move.from, move.to); board = result.board;
          let reward = 1;
          if (result.captured) {
            if (result.captured.spy) { reward = 2000; wins[turn]++; ai.learn(stateBefore, move, reward, ai.getBoardHash(board)); clearTimeout(timeoutId); resolve({ winner: wins[0] >= wins[1] ? 0 : 1, wins }); return; } else { reward = 100; }
          }
          const stateAfter = ai.getBoardHash(board); ai.learn(stateBefore, move, reward, stateAfter); turn = 1 - turn;
        }
      }
      ai1.decayEpsilon(); ai2.decayEpsilon();
      clearTimeout(timeoutId); resolve({ winner: wins[0] >= wins[1] ? 0 : 1, wins });
    } catch (e) { console.error('Game error:', e); clearTimeout(timeoutId); resolve({ winner: 0, wins: [0, 0] }); }
  });
}

let ai1 = new DamekAI(0); let ai2 = new DamekAI(1);
try { if (fs.existsSync('ai1.json')) { ai1.fromJSON(fs.readFileSync('ai1.json', 'utf-8')); } if (fs.existsSync('ai2.json')) { ai2.fromJSON(fs.readFileSync('ai2.json', 'utf-8')); } } catch (e) { }

app.post('/api/train/start', async (req, res) => {
  const { episodes = 1000 } = req.body;
  if (trainingInProgress) { return res.json({ error: 'Entraînement déjà en cours' }); }
  trainingInProgress = true; trainingStatus = { running: true, episode: 0, totalEpisodes: episodes, winRate: 0, states: Object.keys(ai1.qTable).length, epsilon: ai1.epsilon, startTime: Date.now(), history: [] };
  res.json({ status: 'Entraînement lancé', episodes });
  (async () => {
    try {
      for (let ep = 1; ep <= episodes; ep++) {
        const result = await playGame(ai1, ai2, 5000);
        trainingStatus.episode = ep; trainingStatus.states = Object.keys(ai1.qTable).length; trainingStatus.epsilon = ai1.epsilon;
        trainingStatus.history.push({ episode: ep, winner: result.winner, ai_score: result.wins[0], opp_score: result.wins[1], epsilon: ai1.epsilon.toFixed(4), ai_states: trainingStatus.states });
        const wins = trainingStatus.history.filter(h => h.winner === 0).length; trainingStatus.winRate = (wins / ep * 100).toFixed(1);
        if (ep % Math.max(50, Math.floor(episodes / 10)) === 0) {
          try { fs.writeFileSync('ai1.json', ai1.toJSON()); fs.writeFileSync('ai2.json', ai2.toJSON()); fs.writeFileSync('history.json', JSON.stringify(trainingStatus.history, null, 2)); console.log(`✅ Checkpoint: ${ep}/${episodes}`); } catch (e) { }
        }
        if (ep % 100 === 0) { ai1.cleanup(); ai2.cleanup(); }
        await new Promise(resolve => setImmediate(resolve));
      }
      try { fs.writeFileSync('ai1.json', ai1.toJSON()); fs.writeFileSync('ai2.json', ai2.toJSON()); fs.writeFileSync('history.json', JSON.stringify(trainingStatus.history, null, 2)); } catch (e) { }
      trainingStatus.running = false; console.log('✅ Entraînement terminé!');
    } catch (e) { console.error('Training error:', e); trainingStatus.running = false; } finally { trainingInProgress = false; }
  })();
});

app.get('/api/train/status', (req, res) => {
  const elapsed = trainingStatus.startTime ? (Date.now() - trainingStatus.startTime) / 1000 : 0;
  const estimated = trainingStatus.episode > 0 ? (elapsed / (trainingStatus.episode / trainingStatus.totalEpisodes)) - elapsed : 0;
  res.json({ ...trainingStatus, elapsed: Math.floor(elapsed), eta: Math.floor(Math.max(0, estimated)) });
});

app.get('/api/train/history', (req, res) => res.json(trainingStatus.history));

app.get('/api/models/download', (req, res) => {
  try { const ai1Data = JSON.parse(ai1.toJSON()); const ai2Data = JSON.parse(ai2.toJSON());
    res.json({ ai1: ai1Data, ai2: ai2Data, timestamp: new Date().toISOString() }); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/stats', (req, res) => {
  res.json({ ai1_states: Object.keys(ai1.qTable).length, ai2_states: Object.keys(ai2.qTable).length, total_actions: Object.keys(ai1.qTable).length + Object.keys(ai2.qTable).length, epsilon: ai1.epsilon.toFixed(6), training: trainingStatus.running, memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB', port: PORT });
});

// 🆕 PAGE D'ANALYSE GRAPHIQUES
app.get('/analyse', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>📊 Analyse Entraînement</title><script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/3.9.1/chart.min.js"></script><style>body{font-family:'Segoe UI',sans-serif;background:linear-gradient(135deg,#1a1a2e,#16213e);color:#fff;padding:20px}h1{text-align:center;background:linear-gradient(135deg,#4cc9f0,#f72585);-webkit-background-clip:text;-webkit-text-fill-color:transparent}.container{max-width:1200px;margin:0 auto}.stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:15px;margin:20px 0}.stat-card{background:rgba(76,201,240,0.1);border:1px solid #4cc9f0;padding:20px;border-radius:8px;text-align:center}.stat-value{font-size:2em;font-weight:bold;color:#4cc9f0}.stat-label{color:#aaa;font-size:0.9em;margin-top:5px}.charts-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(400px,1fr));gap:20px;margin:20px 0}.chart-container{background:rgba(0,0,0,0.3);padding:20px;border-radius:8px;border:1px solid #4cc9f0}canvas{max-height:300px}.loading{text-align:center;padding:40px}.error{background:rgba(255,100,100,0.2);border:1px solid #ff6464;color:#ff6464;padding:15px;border-radius:6px;margin:10px 0}.success{background:rgba(100,255,100,0.2);border:1px solid #64ff64;color:#64ff64;padding:10px;border-radius:6px;margin:10px 0}</style></head><body><div class="container"><h1>📊 Analyse Entraînement IA Dämek</h1><div id="status"></div><div class="stats-grid" id="stats"></div><div class="charts-grid"><div class="chart-container"><h3>📈 Taux Victoire Progressif</h3><canvas id="chart1"></canvas></div><div class="chart-container"><h3>🧠 États Appris</h3><canvas id="chart2"></canvas></div><div class="chart-container"><h3>🔍 Exploration (Epsilon)</h3><canvas id="chart3"></canvas></div><div class="chart-container"><h3>🏆 Répartition Résultats</h3><canvas id="chart4"></canvas></div></div></div><script>let history=[];let charts={};async function loadData(){try{const e=await fetch("/api/train/status"),t=await e.json(),a=await fetch("/api/train/history"),o=await a.json();history=o;const n=await fetch("/api/stats"),s=await n.json();displayStats(t,s),drawCharts()}catch(e){document.getElementById("status").innerHTML='<div class="error">❌ Erreur: '+e.message+"</div>"}}function displayStats(e,t){const a=history.length>0?history.filter(e=>0===e.winner).length:0,o=[];o.push('<div class="stat-card"><div class="stat-value">'+e.winRate+'%</div><div class="stat-label">Taux Victoire</div></div>'),o.push('<div class="stat-card"><div class="stat-value">'+t.ai1_states.toLocaleString()+'</div><div class="stat-label">États Appris</div></div>'),o.push('<div class="stat-card"><div class="stat-value">'+history.length+'</div><div class="stat-label">Parties Jouées</div></div>'),o.push('<div class="stat-card"><div class="stat-value">'+Math.floor(e.elapsed/60)+'m '+e.elapsed%60+'s</div><div class="stat-label">Durée Totale</div></div>'),o.push('<div class="stat-card"><div class="stat-value">'+t.epsilon+'</div><div class="stat-label">Epsilon</div></div>'),o.push('<div class="stat-card"><div class="stat-value">'+t.memory+'</div><div class="stat-label">Mémoire</div></div>');const n=e.running?'<div class="error">⏳ Entraînement en cours...</div>':'<div class="success">✅ Entraînement terminé!</div>';document.getElementById("stats").innerHTML=o.join(""),document.getElementById("status").innerHTML=n}function drawCharts(){if(0===history.length)return;const e=history.map(e=>e.episode),t=[],a=[],o=history.map(e=>e.ai_states),n=history.map(e=>parseFloat(e.epsilon));let s=0;history.forEach(e=>{0===e.winner&&s++,t.push(100*s/history.length)});const i=history.filter(e=>0===e.winner).length,r=history.length-i;drawChart("chart1",{type:"line",data:{labels:e,datasets:[{label:"Taux Victoire (%)",data:t,borderColor:"#4cc9f0",backgroundColor:"rgba(76,201,240,0.1)",borderWidth:2,fill:!0,tension:.3}]},options:{responsive:!0,maintainAspectRatio:!1,plugins:{legend:{labels:{color:"#fff"}},title:{display:!0,text:"Progression Victoires",color:"#fff"}},scales:{y:{beginAtZero:!0,max:100,ticks:{color:"#fff"},grid:{color:"rgba(255,255,255,0.1)"}},x:{ticks:{color:"#fff"},grid:{color:"rgba(255,255,255,0.1)"}}}}},drawChart("chart2",{type:"line",data:{labels:e,datasets:[{label:"États Uniques",data:o,borderColor:"#f72585",backgroundColor:"rgba(247,37,133,0.1)",borderWidth:2,fill:!0,tension:.3}]},options:{responsive:!0,maintainAspectRatio:!1,plugins:{legend:{labels:{color:"#fff"}},title:{display:!0,text:"Croissance Connaissances",color:"#fff"}},scales:{y:{beginAtZero:!0,ticks:{color:"#fff"},grid:{color:"rgba(255,255,255,0.1)"}},x:{ticks:{color:"#fff"},grid:{color:"rgba(255,255,255,0.1)"}}}}},drawChart("chart3",{type:"line",data:{labels:e,datasets:[{label:"Epsilon (Exploration)",data:n,borderColor:"#77dd77",backgroundColor:"rgba(119,221,119,0.1)",borderWidth:2,fill:!0,tension:.3}]},options:{responsive:!0,maintainAspectRatio:!1,plugins:{legend:{labels:{color:"#fff"}},title:{display:!0,text:"Réduction Exploration",color:"#fff"}},scales:{y:{beginAtZero:!0,ticks:{color:"#fff"},grid:{color:"rgba(255,255,255,0.1)"}},x:{ticks:{color:"#fff"},grid:{color:"rgba(255,255,255,0.1)"}}}}},drawChart("chart4",{type:"doughnut",data:{labels:["Victoires ("+i+")","Défaites ("+r+")"],datasets:[{data:[i,r],backgroundColor:["#4cc9f0","#f72585"],borderColor:["#4cc9f0","#f72585"],borderWidth:2}]},options:{responsive:!0,maintainAspectRatio:!1,plugins:{legend:{labels:{color:"#fff"}},title:{display:!0,text:"Répartition Résultats",color:"#fff"}}}})}function drawChart(e,t){const a=document.getElementById(e).getContext("2d");charts[e]&&charts[e].destroy(),charts[e]=new Chart(a,t)}setInterval(loadData,2e3),loadData()</script></body></html>`);
});

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>🤖 IA Dämek Cloud Training</title><style>body{font-family:'Segoe UI',sans-serif;background:linear-gradient(135deg,#1a1a2e,#16213e);color:#fff;padding:40px}.container{max-width:800px;margin:0 auto;background:rgba(0,0,0,0.3);padding:30px;border-radius:10px;border:2px solid #4cc9f0}h1{background:linear-gradient(135deg,#4cc9f0,#f72585);-webkit-background-clip:text;-webkit-text-fill-color:transparent}button{background:linear-gradient(135deg,#4cc9f0,#f72585);border:none;color:white;padding:12px 24px;border-radius:6px;cursor:pointer;font-weight:600;margin:10px 5px 10px 0}button:hover{transform:translateY(-2px);box-shadow:0 10px 20px rgba(76,201,240,0.3)}.stats{background:rgba(76,201,240,0.1);border:1px solid #4cc9f0;padding:15px;border-radius:6px;margin:20px 0}.stat{margin:10px 0}input{background:rgba(255,255,255,0.1);border:1px solid #4cc9f0;color:white;padding:8px;border-radius:4px;width:100%;box-sizing:border-box}.progress{background:rgba(255,255,255,0.1);height:20px;border-radius:10px;overflow:hidden;margin:10px 0}.progress-bar{background:linear-gradient(90deg,#4cc9f0,#f72585);height:100%;width:0%;transition:width 0.3s}.success{background:rgba(119,221,119,0.2);border:1px solid #77dd77;color:#77dd77;padding:10px;border-radius:4px;margin:10px 0}.link-button{background:rgba(76,201,240,0.2);border:1px solid #4cc9f0;color:#4cc9f0;padding:10px;border-radius:4px;text-decoration:none;display:inline-block;margin-top:10px}</style></head><body><div class="container"><h1>🤖 IA Dämek - Cloud Training</h1><p>L'entraînement se fait dans le cloud ☁️</p><div class="success">✅ Serveur en ligne et stable!</div><div style="margin:20px 0"><label>Parties (Max 1000):</label><input type="number" id="episodes" value="500" min="100" max="1000"></div><button onclick="startTraining()">🚀 Démarrer</button><button onclick="refreshStats()">🔄 Actualiser</button><a href="/analyse" class="link-button" style="margin-left:10px">📊 Voir Analyse</a><div class="stats"><h3>📊 Statut</h3><div class="stat">Partie: <span id="episode">-</span> / <span id="total">-</span></div><div class="stat">Victoires: <span id="winrate">-</span>%</div><div class="stat">États: <span id="states">-</span></div><div class="stat">Epsilon: <span id="epsilon">-</span></div><div class="stat">Temps: <span id="elapsed">-</span>s | ETA: <span id="eta">-</span>s</div><div class="stat">Mémoire: <span id="memory">-</span></div><div class="progress"><div class="progress-bar" id="bar"></div></div><div class="stat">Status: <span id="status">Prêt ✅</span></div></div><button onclick="downloadModels()">💾 Télécharger</button></div><script>async function startTraining(){const e=parseInt(document.getElementById("episodes").value);if(e>1e3)return void alert("Max 1000!");try{const t=await fetch("/api/train/start",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({episodes:e})}),a=await t.json();a.error?alert("❌ "+a.error):alert("✅ Lancé!"),refreshStatus()}catch(e){alert("❌ "+e.message)}}async function refreshStats(){try{const e=await fetch("/api/stats"),t=await e.json();document.getElementById("states").textContent=t.ai1_states.toLocaleString(),document.getElementById("epsilon").textContent=t.epsilon,document.getElementById("memory").textContent=t.memory}catch(e){}}async function refreshStatus(){try{const e=await fetch("/api/train/status"),t=await e.json();document.getElementById("episode").textContent=t.episode,document.getElementById("total").textContent=t.totalEpisodes,document.getElementById("winrate").textContent=t.winRate,document.getElementById("states").textContent=t.states.toLocaleString(),document.getElementById("epsilon").textContent=t.epsilon.toFixed(4),document.getElementById("elapsed").textContent=t.elapsed,document.getElementById("eta").textContent=t.eta;const a=t.totalEpisodes?t.episode/t.totalEpisodes*100:0;document.getElementById("bar").style.width=a+"%",document.getElementById("status").textContent=t.running?"⏳ En cours...":"✅ Prêt",t.running&&setTimeout(refreshStatus,2e3)}catch(e){}}async function downloadModels(){try{const e=await fetch("/api/models/download"),t=await e.json(),a=new Blob([JSON.stringify(t.ai1,null,2)],{type:"application/json"}),o=URL.createObjectURL(a),n=document.createElement("a");n.href=o,n.download="damek_ai.json",n.click()}catch(e){alert("❌ "+e.message)}}refreshStats(),setInterval(refreshStats,5e3)</script></body></html>`);
});

app.get('/health', (req, res) => res.json({ status: 'ok', port: PORT, timestamp: new Date().toISOString() }));

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅ Serveur STABLE sur port ${PORT}\n`);
});

server.on('error', (err) => console.error('Server error:', err));
process.on('unhandledRejection', (reason, promise) => console.error('Unhandled Rejection:', reason));
