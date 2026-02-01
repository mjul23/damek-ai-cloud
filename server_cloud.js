// 🎯 IA STRATÉGIQUE BASÉE SUR LES PATTERNS GAGNANTS

class StrategicAI {
  constructor(player = 0) {
    this.player = player;
    this.qTable = {};
    this.alpha = 0.3;  // Learning rate augmenté
    this.gamma = 0.99;
    this.epsilon = 0.1;  // Peu d'exploration
    
    // TOP PATTERNS GAGNANTS (issue de l'analyse)
    this.topPatterns = [
      { from: [1,1], to: [0,0], weight: 213 },
      { from: [0,1], to: [0,0], weight: 203 },
      { from: [1,2], to: [0,1], weight: 202 },
      { from: [1,3], to: [0,2], weight: 200 },
      { from: [0,2], to: [0,1], weight: 189 },
      { from: [0,0], to: [0,1], weight: 177 },
      { from: [1,0], to: [0,0], weight: 164 },
      { from: [0,3], to: [0,2], weight: 152 },
      { from: [5,6], to: [4,5], weight: 147 },
      { from: [5,7], to: [4,6], weight: 146 }
    ];
    
    // Positions dangereuses à éviter (bottom-right)
    this.dangerousZones = [
      [5,5], [5,6], [5,7], [6,5], [6,6], [6,7], [7,5], [7,6], [7,7]
    ];
    
    // Zones d'attaque à privilégier (top-left)
    this.attackZones = [
      [0,0], [0,1], [0,2], [0,3],
      [1,0], [1,1], [1,2], [1,3]
    ];
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

  // 🎯 Scorer un move basé sur les patterns
  scoreMove(move) {
    let score = 1;
    
    // 1️⃣ Bonus si c'est dans un top pattern
    for (let pattern of this.topPatterns) {
      if (move.from[0] === pattern.from[0] && move.from[1] === pattern.from[1] &&
          move.to[0] === pattern.to[0] && move.to[1] === pattern.to[1]) {
        score += pattern.weight * 10;  // Très gros bonus!
      }
    }
    
    // 2️⃣ Bonus pour moves vers zones d'attaque
    for (let zone of this.attackZones) {
      if (move.to[0] === zone[0] && move.to[1] === zone[1]) {
        score += 50;
      }
    }
    
    // 3️⃣ Pénalité pour moves vers zones dangereuses
    for (let zone of this.dangerousZones) {
      if (move.from[0] === zone[0] && move.from[1] === zone[1]) {
        score -= 100;  // Grosse pénalité!
      }
    }
    
    // 4️⃣ Distance du spy vers opponent's spy
    // Rapprocher son spy vers le centre-haut = bon
    const distToBefore = Math.abs(move.from[0] - 0) + Math.abs(move.from[1] - 1);
    const distToAfter = Math.abs(move.to[0] - 0) + Math.abs(move.to[1] - 1);
    if (distToAfter < distToBefore) {
      score += 30;  // Bonus pour approcher
    }
    
    return score;
  }

  chooseAction(board, moves) {
    if (!moves.length) return null;
    
    // Exploration: random move
    if (Math.random() < this.epsilon) {
      return moves[Math.floor(Math.random() * moves.length)];
    }
    
    // Exploitation: score chaque move
    let bestMove = moves[0];
    let bestScore = this.scoreMove(moves[0]);
    
    for (let move of moves) {
      const score = this.scoreMove(move);
      if (score > bestScore) {
        bestScore = score;
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
    
    // 🎯 BONUS REWARD si c'est un top pattern!
    let bonusReward = reward;
    for (let pattern of this.topPatterns) {
      if (move.from[0] === pattern.from[0] && move.from[1] === pattern.from[1] &&
          move.to[0] === pattern.to[0] && move.to[1] === pattern.to[1]) {
        bonusReward = reward + (pattern.weight * 5);  // Amplifier les bons moves!
      }
    }
    
    const newQ = currentQ + this.alpha * (bonusReward + this.gamma * maxQ - currentQ);
    this.qTable[key] = newQ;
  }

  toJSON() { return JSON.stringify(this.qTable); }
  fromJSON(json) { try { this.qTable = JSON.parse(json); } catch (e) { this.qTable = {}; } }
}

// 📊 Exporter pour Node.js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { StrategicAI };
}
