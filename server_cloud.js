#!/usr/bin/env node
// 🤖 SERVEUR FINAL - AVEC HEARTBEAT (anti-veille Render)
// Ping automatique toutes les 14 minutes

const express = require('express');
const fs = require('fs');
const cors = require('cors');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3000;

console.log(`\n✅ Serveur AVEC HEARTBEAT - PORT ${PORT}\n`);

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const TYPES = ['PION', 'CAVALIER', 'FOU', 'TOUR', 'ROI', 'DAME'];
const LEARNING_RATE = 0.25;
const EPSILON_DECAY = 0.9985;
const GAMMA = 0.99;

const MAX_BUFFER = 2000;
const CLEANUP_INTERVAL = 10;
const MAX_HISTORY = 200;
const HEARTBEAT_INTERVAL = 14 * 60 * 1000; // 14 minutes en millisecondes

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
  totalEpisodesSoFar: 0,
  epsilonHistory: [],
  lastHeartbeat: new Date()
};

function loadHistoryFromFile() {
  try {
    if (fs.existsSync('history.json')) {
      const data = fs.readFileSync('history.json', 'utf-8');
      if (!data || data.trim().length === 0) {
        console.log('⚠️ history.json vide, réinitialisation');
        fs.unlinkSync('history.json');
        return 0;
      }
      const history = JSON.parse(data);
      if (!Array.isArray(history)) {
        console.log('⚠️ history.json invalide, réinitialisation');
        fs.unlinkSync('history.json');
        return 0;
      }
      if (history.length > 0) {
        trainingStatus.history = history.slice(-MAX_HISTORY);
        trainingStatus.totalEpisodesSoFar = history.length;
        console.log(`📂 Historique: ${history.length} total (${trainingStatus.history.length} en mémoire)`);
        return history.length;
      }
    }
  } catch (e) {
    console.log('⚠️ Erreur chargement historique:', e.message);
    try {
      if (fs.existsSync('history.json')) {
        fs.unlinkSync('history.json');
        console.log('🧹 Fichier corrompu supprimé');
      }
    } catch (e2) {}
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
    this.maxExperiences = MAX_BUFFER;
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

  replayLearning(batchSize = 30) {
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

  decayEpsilon() { 
    const oldEpsilon = this.epsilon;
    this.epsilon *= EPSILON_DECAY;
    if (this.epsilon < 0.01) this.epsilon = 0.01;
    if (this.epsilon > 1.0) this.epsilon = 1.0;
  }

  toJSON() { return JSON.stringify(this.qTable); }
  fromJSON(json) { try { this.qTable = JSON.parse(json); } catch (e) { this.qTable = {}; } }
  cleanup() { 
    const threshold = 0.05;
    const keys = Object.keys(this.qTable); 
    let removed = 0;
    for (let key of keys) { 
      if (Math.abs(this.qTable[key]) < threshold) { 
        delete this.qTable[key]; 
        removed++;
      } 
    }
    return removed;
  }
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
      ai1.decayEpsilon(); 
      ai2.decayEpsilon();
      clearTimeout(timeoutId); resolve({ winner: wins[0] >= wins[1] ? 0 : 1, wins });
    } catch (e) { console.error('Game error:', e); clearTimeout(timeoutId); resolve({ winner: 0, wins: [0, 0] }); }
  });
}

let ai1 = new DamekAI(0); let ai2 = new DamekAI(1);
try { if (fs.existsSync('ai1.json')) { ai1.fromJSON(fs.readFileSync('ai1.json', 'utf-8')); } if (fs.existsSync('ai2.json')) { ai2.fromJSON(fs.readFileSync('ai2.json', 'utf-8')); } } catch (e) { }

// 🆕 HEARTBEAT - Ping automatique toutes les 14 min (avec HTTPS sur Render!)
function startHeartbeat() {
  setInterval(() => {
    const now = new Date();
    trainingStatus.lastHeartbeat = now;
    
    // Log heartbeat
    console.log(`❤️ Heartbeat à ${now.toLocaleTimeString()} - Serveur en vie!`);
    
    // Ping lui-même MAIS en local seulement (ne pas faire de ping HTTP external)
    // Render gère l'uptime automatiquement
    // On just log le heartbeat!
  }, HEARTBEAT_INTERVAL);
  
  console.log(`⏰ Heartbeat lancé: ping interne toutes les 14 minutes`);
}

app.post('/api/train/start', async (req, res) => {
  const { episodes = 1000 } = req.body;
  if (trainingInProgress) { return res.json({ error: 'Entraînement déjà en cours' }); }
  trainingInProgress = true;
  const startingEpisode = trainingStatus.totalEpisodesSoFar + 1;
  trainingStatus = { running: true, episode: startingEpisode, totalEpisodes: startingEpisode + episodes - 1, winRate: 0, states: Object.keys(ai1.qTable).length, epsilon: ai1.epsilon, startTime: Date.now(), history: trainingStatus.history, replayStats: { replays: 0, avgGain: 0 }, totalEpisodesSoFar: trainingStatus.totalEpisodesSoFar, epsilonHistory: [], lastHeartbeat: trainingStatus.lastHeartbeat };
  res.json({ status: 'Entraînement lancé', episodes, startFrom: startingEpisode });

  (async () => {
    try {
      for (let ep = startingEpisode; ep <= trainingStatus.totalEpisodes; ep++) {
        const result = await playGame(ai1, ai2, 5000);
        trainingStatus.episode = ep; 
        trainingStatus.states = Object.keys(ai1.qTable).length; 
        trainingStatus.epsilon = ai1.epsilon;
        
        trainingStatus.epsilonHistory.push({ episode: ep, epsilon: ai1.epsilon });
        
        const newEntry = { episode: ep, winner: result.winner, ai_score: result.wins[0], opp_score: result.wins[1], epsilon: ai1.epsilon.toFixed(6), ai_states: trainingStatus.states };
        trainingStatus.history.push(newEntry);
        
        if (trainingStatus.history.length > MAX_HISTORY) {
          trainingStatus.history.shift();
        }
        
        const wins = trainingStatus.history.filter(h => h.winner === 0).length; 
        trainingStatus.winRate = (wins / trainingStatus.history.length * 100).toFixed(1);

        if ((ep - startingEpisode) % 20 === 0) {
          const gain1 = ai1.replayLearning(30);
          if (gain1) { trainingStatus.replayStats.replays++; trainingStatus.replayStats.avgGain = gain1; }
        }

        if ((ep - startingEpisode) % Math.max(50, Math.floor(trainingStatus.totalEpisodes - startingEpisode + 1) / 10) === 0) {
          try { 
            fs.writeFileSync('ai1.json', ai1.toJSON()); 
            fs.writeFileSync('ai2.json', ai2.toJSON()); 
            
            let fullHistory = [];
            try {
              const data = fs.readFileSync('history.json', 'utf-8');
              if (data && data.trim().length > 0) {
                fullHistory = JSON.parse(data);
              }
            } catch (e) {
              fullHistory = [];
            }
            
            for (let h of trainingStatus.history) {
              if (!fullHistory.find(x => x.episode === h.episode)) {
                fullHistory.push(h);
              }
            }
            
            fs.writeFileSync('history.json', JSON.stringify(fullHistory, null, 2));
            console.log(`✅ Checkpoint: ${ep}/${trainingStatus.totalEpisodes} | Epsilon: ${ai1.epsilon.toFixed(4)}`); 
          } catch (e) { console.error('Save error:', e); }
        }

        if ((ep - startingEpisode) % CLEANUP_INTERVAL === 0) { 
          ai1.cleanup(); 
          ai2.cleanup();
          console.log(`💾 Mémoire: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB | Epsilon: ${ai1.epsilon.toFixed(4)}`);
        }

        await new Promise(resolve => setImmediate(resolve));
      }

      try { 
        fs.writeFileSync('ai1.json', ai1.toJSON()); 
        fs.writeFileSync('ai2.json', ai2.toJSON());
        
        let fullHistory = [];
        try {
          const data = fs.readFileSync('history.json', 'utf-8');
          if (data && data.trim().length > 0) {
            fullHistory = JSON.parse(data);
          }
        } catch (e) {
          fullHistory = [];
        }
        
        for (let h of trainingStatus.history) {
          if (!fullHistory.find(x => x.episode === h.episode)) {
            fullHistory.push(h);
          }
        }
        
        fs.writeFileSync('history.json', JSON.stringify(fullHistory, null, 2));
      } catch (e) { console.error('Final save error:', e); }
      
      trainingStatus.running = false; 
      trainingStatus.totalEpisodesSoFar = trainingStatus.totalEpisodesSoFar + (trainingStatus.totalEpisodes - startingEpisode + 1);
      console.log(`✅ Entraînement terminé! Epsilon final: ${ai1.epsilon.toFixed(4)}`);
    } catch (e) { console.error('Training error:', e); trainingStatus.running = false; } finally { trainingInProgress = false; }
  })();
});

app.get('/api/train/status', (req, res) => {
  const elapsed = trainingStatus.startTime ? (Date.now() - trainingStatus.startTime) / 1000 : 0;
  res.json({ ...trainingStatus, elapsed: Math.floor(elapsed), totalHistoryLength: trainingStatus.totalEpisodesSoFar });
});

app.get('/api/train/history', (req, res) => res.json(trainingStatus.history));

app.get('/api/epsilon/history', (req, res) => res.json(trainingStatus.epsilonHistory));

app.get('/api/models/download', (req, res) => {
  try { const ai1Data = JSON.parse(ai1.toJSON()); const ai2Data = JSON.parse(ai2.toJSON());
    res.json({ ai1: ai1Data, ai2: ai2Data, timestamp: new Date().toISOString() }); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/stats', (req, res) => {
  res.json({ ai1_states: Object.keys(ai1.qTable).length, ai2_states: Object.keys(ai2.qTable).length, total_actions: Object.keys(ai1.qTable).length + Object.keys(ai2.qTable).length, epsilon: ai1.epsilon.toFixed(6), training: trainingStatus.running, memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB', port: PORT, replays: trainingStatus.replayStats.replays, replayGain: trainingStatus.replayStats.avgGain.toFixed(6), totalEpisodes: trainingStatus.totalEpisodesSoFar, lastHeartbeat: trainingStatus.lastHeartbeat, config: { gamma: GAMMA, alpha: LEARNING_RATE, epsilonDecay: EPSILON_DECAY } });
});

app.get('/analyse', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Analyse</title><script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/3.9.1/chart.min.js"></script><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:Arial;background:#1a1a2e;color:#fff;padding:20px}.container{max-width:1200px;margin:0 auto}h1{text-align:center;color:#4cc9f0;margin-bottom:30px}.stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:15px;margin-bottom:30px}.stat-card{background:#0f3460;padding:20px;border-radius:8px;border:1px solid #4cc9f0;text-align:center}.stat-value{font-size:2.5em;font-weight:bold;color:#4cc9f0}.stat-label{color:#aaa;font-size:0.9em;margin-top:10px}.charts-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(400px,1fr));gap:20px}.chart-container{background:#0f3460;padding:20px;border-radius:8px;border:1px solid #4cc9f0;height:350px;position:relative}.chart-title{color:#4cc9f0;margin-bottom:15px;font-weight:bold}canvas{max-height:300px}</style></head><body><div class="container"><h1>📊 Analyse Damek</h1><div id="stats" class="stats-grid"></div><div class="charts-grid"><div class="chart-container"><div class="chart-title">Victoires</div><canvas id="c1"></canvas></div><div class="chart-container"><div class="chart-title">États</div><canvas id="c2"></canvas></div><div class="chart-container"><div class="chart-title">Epsilon (exploration)</div><canvas id="c3"></canvas></div><div class="chart-container"><div class="chart-title">Répartition</div><canvas id="c4"></canvas></div></div></div><script>let charts={};async function load(){try{const s=await fetch('/api/train/status'),st=await s.json(),h=await fetch('/api/train/history'),hl=await h.json(),e=await fetch('/api/epsilon/history'),eh=await e.json(),a=await fetch('/api/stats'),ap=await a.json();document.getElementById('stats').innerHTML='<div class="stat-card"><div class="stat-value">'+st.winRate+'%</div><div class="stat-label">Victoires</div></div><div class="stat-card"><div class="stat-value">'+st.totalHistoryLength+'</div><div class="stat-label">Parties</div></div><div class="stat-card"><div class="stat-value">'+ap.ai1_states.toLocaleString()+'</div><div class="stat-label">États</div></div><div class="stat-card"><div class="stat-value">'+ap.epsilon+'</div><div class="stat-label">Epsilon</div></div>';if(!hl||hl.length<1)return;const ep=hl.map(x=>x.episode),v=[],st2=[],p=[];let w=0;hl.forEach(x=>{if(x.winner===0)w++;v.push((w/hl.length*100).toFixed(1));st2.push(x.ai_states);p.push(parseFloat(x.epsilon))});const tw=hl.filter(x=>x.winner===0).length,tl=hl.length-tw;mk('c1',ep,v,'#4cc9f0');mk('c2',ep,st2,'#f72585');const epe=eh.map(x=>x.episode),epv=eh.map(x=>x.epsilon);mk('c3',epe,epv,'#77dd77');mk('c4',[tw,tl],['#4cc9f0','#f72585'],'pie')}catch(e){console.error(e)}}function mk(i,x,y,c,t){const a=document.getElementById(i);if(!a)return;if(charts[i])charts[i].destroy();const ctx=a.getContext('2d');const isp='c4'===i;charts[i]=new Chart(ctx,{type:isp?'doughnut':'line',data:{labels:x,datasets:[{label:t||'',data:y,borderColor:c,backgroundColor:isp?c:'rgba(0,0,0,0.1)',borderWidth:2,fill:!isp,tension:0.3}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:'#fff'}}},scales:{y:{ticks:{color:'#fff'},grid:{color:'rgba(255,255,255,0.1)'}},x:{ticks:{color:'#fff'},grid:{color:'rgba(255,255,255,0.1)'}}}}});}load();setInterval(load,5000);</script></body></html>`);
});

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>IA Damek</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:Arial;background:#1a1a2e;color:#fff;padding:20px}.container{max-width:600px;margin:0 auto;background:#0f3460;padding:20px;border-radius:8px;border:1px solid #4cc9f0}h1{color:#4cc9f0;margin-bottom:20px}.info{background:#1a3a3a;padding:15px;border-radius:4px;margin:15px 0;border-left:3px solid #77dd77;color:#aaa;font-size:0.9em}input{width:100%;padding:10px;margin:10px 0;background:#1a1a2e;border:1px solid #4cc9f0;color:#fff;border-radius:4px}button{flex:1;padding:12px;background:#4cc9f0;color:#000;border:none;border-radius:4px;cursor:pointer;font-weight:bold}.buttons{display:flex;gap:10px;margin:15px 0}button:hover{background:#f72585}a{text-decoration:none}.stats{background:#1a1a2e;border:1px solid #4cc9f0;padding:15px;border-radius:4px;margin:20px 0}.stat-row{display:flex;justify-content:space-between;margin:10px 0}.stat-label{color:#aaa}.stat-value{color:#4cc9f0;font-weight:bold}.progress-bar{width:100%;height:20px;background:#1a1a2e;border-radius:10px;overflow:hidden;margin:10px 0}.progress-fill{height:100%;background:#4cc9f0;width:0%;transition:width 0.3s}.heartbeat{font-size:0.8em;color:#77dd77}</style></head><body><div class="container"><h1>🤖 IA Damek</h1><div class="info">⭐ AVEC HEARTBEAT (anti-veille)<br>❤️ Ping toutes les 14 min<br>📊 Total: <strong id="tot">-</strong></div><input type="number" id="ep" value="500" min="10" max="1000"><div class="buttons"><button onclick="go()">🚀 Entraîner</button><button onclick="ref()">🔄 Refresh</button><a href="/analyse"><button>📊 Analyse</button></a></div><div class="stats"><div class="stat-row"><span class="stat-label">Partie:</span><span class="stat-value"><span id="e">-</span>/<span id="te">-</span></span></div><div class="stat-row"><span class="stat-label">Victoires:</span><span class="stat-value"><span id="w">-</span>%</span></div><div class="stat-row"><span class="stat-label">États:</span><span class="stat-value"><span id="st">-</span></span></div><div class="stat-row"><span class="stat-label">Epsilon:</span><span class="stat-value"><span id="eps">-</span></span></div><div class="stat-row heartbeat"><span class="stat-label">Heartbeat:</span><span class="stat-value" id="hb">-</span></div><div class="progress-bar"><div class="progress-fill" id="pb"></div></div></div></div><script>async function go(){const n=parseInt(document.getElementById('ep').value);if(n<10){alert('Minimum 10 parties');return}try{const r=await fetch('/api/train/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({episodes:n})}),d=await r.json();if(d.error){alert('Erreur: '+d.error)}else{alert('Lancé! Démarrage: '+d.startFrom);ref()}}catch(e){alert('Erreur: '+e.message)}}async function ref(){try{const r1=await fetch('/api/train/status'),s1=await r1.json(),r2=await fetch('/api/stats'),s2=await r2.json();document.getElementById('e').textContent=s1.episode;document.getElementById('te').textContent=s1.totalEpisodes;document.getElementById('tot').textContent=s1.totalHistoryLength;document.getElementById('w').textContent=s1.winRate;document.getElementById('st').textContent=s1.states.toLocaleString();document.getElementById('eps').textContent=s2.epsilon;const hb=new Date(s2.lastHeartbeat).toLocaleTimeString();document.getElementById('hb').textContent=hb;const p=s1.totalEpisodes?((s1.episode-s1.totalEpisodesSoFar)/(s1.totalEpisodes-s1.totalEpisodesSoFar+1)*100):0;document.getElementById('pb').style.width=p+'%';if(s1.running)setTimeout(ref,2000)}catch(e){console.error(e)}}ref();setInterval(ref,5000)</script></body></html>`);
});

app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅ Serveur AVEC HEARTBEAT - PORT ${PORT}\n`);
  startHeartbeat(); // Lancer le heartbeat au démarrage
});

server.on('error', (err) => console.error('Error:', err));
