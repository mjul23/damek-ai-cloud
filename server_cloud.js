#!/usr/bin/env node
// 🤖 SERVEUR CLOUD - IA DÄMEK FINAL COMPLET
// Gamma: 0.99 | Alpha: 0.25 | Historique cumulatif | Analyse STABLE sans boucle

const express = require('express');
const fs = require('fs');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

console.log(`\n✅ Serveur OPTIMISÉ FINAL sur port ${PORT}\n`);

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const TYPES = ['PION', 'CAVALIER', 'FOU', 'TOUR', 'ROI', 'DAME'];
const LEARNING_RATE = 0.25;
const EPSILON_DECAY = 0.995;
const GAMMA = 0.99;

let trainingStatus = { 
  running: false, 
  episode: 0, 
  totalEpisodes: 0, 
  winRate: 0, 
  states: 0, 
  epsilon: 1.0, 
  startTime: null, 
  history: [],
  replayStats: { replays: 0, avgGain: 0 },
  totalEpisodesSoFar: 0
};

function loadHistoryFromFile() {
  try {
    if (fs.existsSync('history.json')) {
      const data = fs.readFileSync('history.json', 'utf-8');
      const history = JSON.parse(data);
      if (Array.isArray(history) && history.length > 0) {
        trainingStatus.history = history;
        trainingStatus.totalEpisodesSoFar = history.length;
        console.log(`📂 Historique chargé: ${history.length} parties`);
        return history.length;
      }
    }
  } catch (e) {
    console.log('⚠️ Impossible de charger historique');
  }
  return 0;
}

const totalLoaded = loadHistoryFromFile();
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
  constructor(player = 0) { 
    this.player = player; 
    this.qTable = {}; 
    this.alpha = LEARNING_RATE;
    this.gamma = GAMMA;
    this.epsilon = 1.0;
    this.experiences = [];
    this.maxExperiences = 10000;
  }

  getBoardHash(board) { 
    let hash = ''; 
    for (let r = 0; r < 8; r++) { 
      for (let c = 0; c < 8; c++) { 
        const p = board[r][c]; 
        hash += p ? `${p.p}${p.spy ? 'S' : ''}` : '.'; 
      } 
    } 
    return hash; 
  }

  chooseAction(board, moves) { 
    if (!moves.length) return null; 
    if (Math.random() < this.epsilon) { 
      return moves[Math.floor(Math.random() * moves.length)]; 
    } 
    const state = this.getBoardHash(board); 
    let bestMove = moves[0]; 
    let bestQ = -Infinity; 
    for (let move of moves) { 
      const key = `${state}:${move.from[0]},${move.from[1]},${move.to[0]},${move.to[1]}`; 
      const q = this.qTable[key] || 0; 
      if (q > bestQ) { 
        bestQ = q; 
        bestMove = move; 
      } 
    } 
    return bestMove; 
  }

  learn(stateBefore, move, reward, stateAfter) { 
    const key = `${stateBefore}:${move.from[0]},${move.from[1]},${move.to[0]},${move.to[1]}`; 
    const currentQ = this.qTable[key] || 0; 
    let maxQ = 0; 
    for (let k in this.qTable) { 
      if (k.startsWith(stateAfter + ':')) { 
        maxQ = Math.max(maxQ, this.qTable[k]); 
      } 
    } 
    const newQ = currentQ + this.alpha * (reward + this.gamma * maxQ - currentQ); 
    this.qTable[key] = newQ;
    this.experiences.push({ stateBefore, move, reward, stateAfter });
    if (this.experiences.length > this.maxExperiences) {
      this.experiences.shift();
    }
  }

  replayLearning(batchSize = 50) {
    if (this.experiences.length < batchSize) return 0;
    let totalGain = 0;
    for (let i = 0; i < batchSize; i++) {
      const idx = Math.floor(Math.random() * this.experiences.length);
      const exp = this.experiences[idx];
      const key = `${exp.stateBefore}:${exp.move.from[0]},${exp.move.from[1]},${exp.move.to[0]},${exp.move.to[1]}`;
      const oldQ = this.qTable[key] || 0;
      let maxQ = 0;
      for (let k in this.qTable) {
        if (k.startsWith(exp.stateAfter + ':')) {
          maxQ = Math.max(maxQ, this.qTable[k]);
        }
      }
      const newQ = oldQ + this.alpha * (exp.reward + this.gamma * maxQ - oldQ);
      const gain = Math.abs(newQ - oldQ);
      totalGain += gain;
      this.qTable[key] = newQ;
    }
    return totalGain / batchSize;
  }

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
            if (result.captured.spy) { reward = 5000; wins[turn]++; ai.learn(stateBefore, move, reward, ai.getBoardHash(board)); clearTimeout(timeoutId); resolve({ winner: wins[0] >= wins[1] ? 0 : 1, wins }); return; } else { reward = 200; }
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
  trainingInProgress = true;
  const startingEpisode = trainingStatus.totalEpisodesSoFar + 1;
  trainingStatus = { running: true, episode: startingEpisode, totalEpisodes: startingEpisode + episodes - 1, winRate: 0, states: Object.keys(ai1.qTable).length, epsilon: ai1.epsilon, startTime: Date.now(), history: trainingStatus.history, replayStats: { replays: 0, avgGain: 0 }, totalEpisodesSoFar: trainingStatus.totalEpisodesSoFar };
  res.json({ status: 'Entraînement lancé', episodes, startFrom: startingEpisode });

  (async () => {
    try {
      for (let ep = startingEpisode; ep <= trainingStatus.totalEpisodes; ep++) {
        const result = await playGame(ai1, ai2, 5000);
        trainingStatus.episode = ep; trainingStatus.states = Object.keys(ai1.qTable).length; trainingStatus.epsilon = ai1.epsilon;
        trainingStatus.history.push({ episode: ep, winner: result.winner, ai_score: result.wins[0], opp_score: result.wins[1], epsilon: ai1.epsilon.toFixed(4), ai_states: trainingStatus.states });
        const wins = trainingStatus.history.filter(h => h.winner === 0).length; trainingStatus.winRate = (wins / trainingStatus.history.length * 100).toFixed(1);
        if ((ep - startingEpisode) % 20 === 0) {
          const gain1 = ai1.replayLearning(50);
          if (gain1) { trainingStatus.replayStats.replays++; trainingStatus.replayStats.avgGain = gain1; }
        }
        if ((ep - startingEpisode) % Math.max(50, Math.floor(episodes / 10)) === 0) {
          try { fs.writeFileSync('ai1.json', ai1.toJSON()); fs.writeFileSync('ai2.json', ai2.toJSON()); fs.writeFileSync('history.json', JSON.stringify(trainingStatus.history, null, 2)); console.log(`✅ Checkpoint: ${ep}/${trainingStatus.totalEpisodes}`); } catch (e) { }
        }
        if ((ep - startingEpisode) % 150 === 0) { ai1.cleanup(); ai2.cleanup(); }
        await new Promise(resolve => setImmediate(resolve));
      }
      try { fs.writeFileSync('ai1.json', ai1.toJSON()); fs.writeFileSync('ai2.json', ai2.toJSON()); fs.writeFileSync('history.json', JSON.stringify(trainingStatus.history, null, 2)); } catch (e) { }
      trainingStatus.running = false; trainingStatus.totalEpisodesSoFar = trainingStatus.history.length;
      console.log(`✅ Entraînement terminé! Total: ${trainingStatus.history.length} parties`);
    } catch (e) { console.error('Training error:', e); trainingStatus.running = false; } finally { trainingInProgress = false; }
  })();
});

app.get('/api/train/status', (req, res) => {
  const elapsed = trainingStatus.startTime ? (Date.now() - trainingStatus.startTime) / 1000 : 0;
  res.json({ ...trainingStatus, elapsed: Math.floor(elapsed), totalHistoryLength: trainingStatus.history.length });
});

app.get('/api/train/history', (req, res) => res.json(trainingStatus.history));

app.get('/api/models/download', (req, res) => {
  try { const ai1Data = JSON.parse(ai1.toJSON()); const ai2Data = JSON.parse(ai2.toJSON());
    res.json({ ai1: ai1Data, ai2: ai2Data, timestamp: new Date().toISOString() }); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/stats', (req, res) => {
  res.json({ ai1_states: Object.keys(ai1.qTable).length, ai2_states: Object.keys(ai2.qTable).length, total_actions: Object.keys(ai1.qTable).length + Object.keys(ai2.qTable).length, epsilon: ai1.epsilon.toFixed(6), training: trainingStatus.running, memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB', port: PORT, replays: trainingStatus.replayStats.replays, replayGain: trainingStatus.replayStats.avgGain.toFixed(6), totalEpisodes: trainingStatus.history.length, config: { gamma: GAMMA, alpha: LEARNING_RATE, epsilonDecay: EPSILON_DECAY } });
});

app.get('/analyse', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>📊 Analyse</title><script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/3.9.1/chart.min.js"><\/script><style>body{font-family:Arial;background:#1a1a2e;color:#fff;padding:20px}h1{text-align:center;color:#4cc9f0}.container{max-width:1200px;margin:0 auto}.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:15px;margin:20px 0}.stat{background:#0f3460;padding:15px;border-radius:8px;border:1px solid #4cc9f0;text-align:center}.stat-val{font-size:2em;font-weight:bold;color:#4cc9f0}.stat-lbl{color:#aaa;font-size:0.9em}.charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(350px,1fr));gap:20px;margin:20px 0}.chart{background:#0f3460;padding:15px;border-radius:8px;border:1px solid #4cc9f0;height:300px}.loading{text-align:center;padding:40px;color:#4cc9f0}</style></head><body><div class="container"><h1>📊 Analyse Entraînement</h1><div id="stats"></div><div id="charts"></div></div><script>let charts={};function show(n,s){const h='<div class="stats"><div class="stat"><div class="stat-val">'+s.winRate+'%<\/div><div class="stat-lbl">Victoires<\/div><\/div><div class="stat"><div class="stat-val">'+n.totalHistoryLength+'<\/div><div class="stat-lbl">Parties<\/div><\/div><div class="stat"><div class="stat-val">'+s.ai1_states.toLocaleString()+'<\/div><div class="stat-lbl">États<\/div><\/div><div class="stat"><div class="stat-val">'+s.epsilon+'<\/div><div class="stat-lbl">Epsilon<\/div><\/div><\/div>';document.getElementById('stats').innerHTML=h}function draw(h){if(!h||h.length<1){document.getElementById('charts').innerHTML='<div class="loading">Pas de données<\/div>';return}const e=h.map(x=>x.episode),w=[],s=[],p=[];let n=0;h.forEach(x=>{if(x.winner===0)n++;w.push((n/h.length*100).toFixed(1));s.push(x.ai_states);p.push(parseFloat(x.epsilon))});const v=h.filter(x=>x.winner===0).length;const d=h.length-v;document.getElementById('charts').innerHTML='<canvas id="c1"><\/canvas><canvas id="c2"><\/canvas><canvas id="c3"><\/canvas><canvas id="c4"><\/canvas>';setTimeout(()=>{mk('c1','Victoires',e,w,'#4cc9f0');mk('c2','États',e,s,'#f72585');mk('c3','Epsilon',e,p,'#77dd77');mk('c4','Pie',[v,d],['Vic','Def'],['#4cc9f0','#f72585'])},100)}function mk(i,l,x,y,c){const f=document.getElementById(i);if(!f)return;if(charts[i])charts[i].destroy();const t='c4'===i?'doughnut':'line';charts[i]=new Chart(f,{type:t,data:{labels:x,datasets:[{label:l,data:y,borderColor:c,backgroundColor:c+'33',borderWidth:2,fill:true,tension:0.3}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:'#fff'}}},scales:{y:{ticks:{color:'#fff'},grid:{color:'rgba(255,255,255,0.1)'}},x:{ticks:{color:'#fff'},grid:{color:'rgba(255,255,255,0.1)'}}}})})} async function load(){try{const r1=await fetch('/api/train/status');const s1=await r1.json();const r2=await fetch('/api/train/history');const h=await r2.json();const r3=await fetch('/api/stats');const s2=await r3.json();show(s1,s2);draw(h)}catch(e){document.getElementById('stats').innerHTML='<div style="color:#ff6464">Erreur: '+e.message+'<\/div>'}}load();const timer=setInterval(load,5000);<\/script><\/body><\/html>`);
});

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>🤖 IA Dämek</title><style>body{font-family:Arial;background:#1a1a2e;color:#fff;padding:20px}.c{max-width:600px;margin:0 auto;background:#0f3460;padding:20px;border-radius:8px;border:1px solid #4cc9f0}h1{color:#4cc9f0}.b{background:#1a3a3a;padding:10px;border-radius:4px;margin:10px 0;border-left:3px solid #77dd77}btn{background:#4cc9f0;border:none;color:#000;padding:10px 20px;border-radius:4px;cursor:pointer;font-weight:bold;margin:10px 5px 10px 0}btn:hover{background:#f72585;color:#fff}inp{background:#1a1a2e;border:1px solid #4cc9f0;color:#fff;padding:8px;border-radius:4px;width:100%;box-sizing:border-box;margin:10px 0}button{background:#4cc9f0;border:none;color:#000;padding:10px 20px;border-radius:4px;cursor:pointer;font-weight:bold;margin:10px 5px 10px 0}button:hover{background:#f72585}input{background:#1a1a2e;border:1px solid #4cc9f0;color:#fff;padding:8px;border-radius:4px;width:100%;box-sizing:border-box;margin:10px 0}.stats{background:#1a1a2e;border:1px solid #4cc9f0;padding:15px;border-radius:4px;margin:15px 0}.bar{background:#1a1a2e;height:20px;border-radius:10px;overflow:hidden;margin:10px 0}.fill{background:#4cc9f0;height:100%;width:0%;transition:width 0.3s}a{color:#4cc9f0}</style></head><body><div class="c"><h1>🤖 IA Dämek</h1><div class="b">⭐ Gamma:0.99 | Alpha:0.25 | Replay:✅<br/>📊 Total: <strong id="total">-</strong></div><input type="number" id="ep" value="500" min="100" max="1000"><button onclick="go()">🚀 Entraîner</button><button onclick="ref()">🔄 Refresh</button><a href="/analyse"><button>📊 Analyse</button></a><div class="stats"><div>Partie: <span id="e">-</span>/<span id="te">-</span></div><div>Victoires: <span id="w">-</span>%</div><div>États: <span id="st">-</span></div><div class="bar"><div class="fill" id="pb"><\/div><\/div><\/div><\/div><script>async function go(){const n=parseInt(document.getElementById('ep').value);try{await fetch('/api/train/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({episodes:n})});ref()}catch(e){alert('Err:'+e)}}async function ref(){try{const r1=await fetch('/api/train/status');const s1=await r1.json();const r2=await fetch('/api/stats');const s2=await r2.json();document.getElementById('e').textContent=s1.episode;document.getElementById('te').textContent=s1.totalEpisodes;document.getElementById('total').textContent=s1.totalHistoryLength;document.getElementById('w').textContent=s1.winRate;document.getElementById('st').textContent=s1.states.toLocaleString();const p=s1.totalEpisodes?(s1.episode-s1.totalEpisodesSoFar)/(s1.totalEpisodes-s1.totalEpisodesSoFar+1)*100:0;document.getElementById('pb').style.width=p+'%';if(s1.running)setTimeout(ref,2000)}catch(e){}}ref();setInterval(ref,5000)<\/script><\/body><\/html>`);
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅ Serveur OPTIMISÉ FINAL - PORT ${PORT}\n`);
});

server.on('error', (err) => console.error('Error:', err));
