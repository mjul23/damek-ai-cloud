#!/usr/bin/env node
// 🤖 SERVEUR CLOUD - IA DÄMEK TRAINING + ANALYSE (FIXED)
const express = require('express');
const fs = require('fs');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

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

// PAGE ANALYSE - FIXE
app.get('/analyse', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>📊 Analyse</title><script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/3.9.1/chart.min.js"></script><style>body{font-family:Arial;background:#1a1a2e;color:#fff;padding:20px}h1{text-align:center;color:#4cc9f0}.container{max-width:1200px;margin:0 auto}.stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:15px;margin:20px 0}.stat-card{background:#0f3460;padding:15px;border-radius:8px;text-align:center;border:1px solid #4cc9f0}.stat-value{font-size:1.8em;font-weight:bold;color:#4cc9f0}.stat-label{color:#aaa;font-size:0.9em}.charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(350px,1fr));gap:20px;margin:20px 0}.chart-box{background:#0f3460;padding:15px;border-radius:8px;border:1px solid #4cc9f0}.error{background:#ff6464;color:#fff;padding:15px;border-radius:6px;margin:10px 0}.loading{text-align:center;padding:40px;color:#4cc9f0}</style></head><body><div class="container"><h1>📊 Analyse Entraînement</h1><div id="status"></div><div class="stats-grid" id="stats"></div><div class="charts" id="charts"></div></div><script>let history=[];let charts={};async function loadData(){try{const e=await fetch("/api/train/status"),t=await e.json(),a=await fetch("/api/train/history"),o=await a.json();history=o;const n=await fetch("/api/stats"),s=await n.json();displayStats(t,s),drawCharts()}catch(e){document.getElementById("status").innerHTML='<div class="error">Erreur: '+e.message+'</div>'}}function displayStats(e,t){const a=[];a.push('<div class="stat-card"><div class="stat-value">'+e.winRate+'%</div><div class="stat-label">Victoires</div></div>'),a.push('<div class="stat-card"><div class="stat-value">'+history.length+'</div><div class="stat-label">Parties</div></div>'),a.push('<div class="stat-card"><div class="stat-value">'+t.ai1_states.toLocaleString()+'</div><div class="stat-label">États</div></div>'),a.push('<div class="stat-card"><div class="stat-value">'+t.epsilon+'</div><div class="stat-label">Epsilon</div></div>'),document.getElementById("stats").innerHTML=a.join("")}function drawCharts(){if(0===history.length){document.getElementById("charts").innerHTML='<div class="loading">Pas de données</div>';return}const e=history.map(e=>e.episode),t=[],a=history.map(e=>e.ai_states),o=history.map(e=>parseFloat(e.epsilon));let n=0;history.forEach(e=>{0===e.winner&&n++,t.push(100*n/history.length)});const s=history.filter(e=>0===e.winner).length,i=history.length-s;createChart("Victoires",e,t,"#4cc9f0"),createChart("États",e,a,"#f72585"),createChart("Epsilon",e,o,"#77dd77"),createChart("Répartition",[s+" Victoires",i+" Défaites"],[s,i],"pie")}function createChart(e,t,a,o){const n=document.createElement("div");n.className="chart-box";const s=document.createElement("canvas");n.innerHTML="<h3>"+e+"</h3>",n.appendChild(s);document.getElementById("charts").appendChild(n);const i=s.getContext("2d"),l={type:"pie"===o?"doughnut":"line",data:{labels:"pie"===o?t:t,datasets:[{label:e,data:a,borderColor:o,backgroundColor:"pie"===o?["#4cc9f0","#f72585"]:"rgba(76,201,240,0.1)",borderWidth:2,fill:"pie"!==o,tension:.3}]},options:{responsive:!0,maintainAspectRatio:!0,plugins:{legend:{labels:{color:"#fff"}}},scales:{y:{ticks:{color:"#fff"},grid:{color:"rgba(255,255,255,0.1)"}},x:{ticks:{color:"#fff"},grid:{color:"rgba(255,255,255,0.1)"}}}}};new Chart(i,l)}loadData(),setInterval(loadData,2e3)</script></body></html>`);
});

// PAGE PRINCIPALE
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>🤖 IA Dämek</title><style>body{font-family:Arial;background:#1a1a2e;color:#fff;padding:20px}.container{max-width:600px;margin:0 auto;background:#0f3460;padding:20px;border-radius:8px;border:1px solid #4cc9f0}h1{color:#4cc9f0}button{background:#4cc9f0;border:none;color:#000;padding:10px 20px;border-radius:4px;cursor:pointer;font-weight:bold;margin:10px 5px 10px 0}button:hover{background:#f72585;color:#fff}input{background:#1a1a2e;border:1px solid #4cc9f0;color:#fff;padding:8px;border-radius:4px;width:100%;box-sizing:border-box;margin:10px 0}.stats{background:#1a1a2e;border:1px solid #4cc9f0;padding:15px;border-radius:4px;margin:15px 0}.progress{background:#1a1a2e;height:20px;border-radius:10px;overflow:hidden;margin:10px 0}.progress-bar{background:#4cc9f0;height:100%;width:0%;transition:width 0.3s}a{color:#4cc9f0;text-decoration:none}a:hover{color:#f72585}</style></head><body><div class="container"><h1>🤖 IA Dämek - Cloud</h1><input type="number" id="episodes" value="500" min="100" max="1000"><button onclick="start()">🚀 Entrainer</button><button onclick="refresh()">🔄 Refresh</button><a href="/analyse" style="margin-left:10px"><button>📊 Analyse</button></a><div class="stats"><div>Partie: <span id="episode">-</span>/<span id="total">-</span></div><div>Victoires: <span id="winrate">-</span>%</div><div>États: <span id="states">-</span></div><div><div class="progress"><div class="progress-bar" id="bar"></div></div></div></div></div><script>async function start(){const e=parseInt(document.getElementById("episodes").value);try{await fetch("/api/train/start",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({episodes:e})}),refresh()}catch(e){alert("Erreur: "+e.message)}}async function refresh(){try{const e=await fetch("/api/train/status"),t=await e.json();document.getElementById("episode").textContent=t.episode,document.getElementById("total").textContent=t.totalEpisodes,document.getElementById("winrate").textContent=t.winRate,document.getElementById("states").textContent=t.states.toLocaleString();const a=t.totalEpisodes?(t.episode/t.totalEpisodes*100):0;document.getElementById("bar").style.width=a+"%",t.running&&setTimeout(refresh,2e3)}catch(e){}}refresh(),setInterval(refresh,5e3)</script></body></html>`);
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅ Serveur sur port ${PORT}\n`);
});

server.on('error', (err) => console.error('Error:', err));
