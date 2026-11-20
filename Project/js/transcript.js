/**
 * Three.js Story Video Renderer — Transcript module
 *
 * Handles loading, parsing, and duration analysis of the word-level transcript CSV.
 * Calculates clause durations and matches to scene map shots.
 */

export class Transcript {
  constructor() {
    this.data = null; // Parsed data
    this.rows = []; // Raw CSV rows {start, end, text}
    this.clauses = []; // Split clauses from scene map
  }

  loadCSV(text) {
    this.rows = [];
    this.data = null;

    const lines = text.split('\n').filter(l => l.trim());
    if (lines.length < 2) return;

    // Skip header line
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      // Parse CSV: start,end,text
      const parts = line.split(',').map(p => p.trim().replace(/^"|"$/g, ''));
      if (parts.length >= 3) {
        this.rows.push({
          start: parseFloat(parts[0]),
          end: parseFloat(parts[1]),
          text: parts.slice(2).join(',') // re-join in case text contains commas
        });
      }
    }

    this.data = { rows: this.rows };
    this.updateOverview();
  }

  loadJSON(data) {
    this.rows = data.rows || [];
    this.data = data;
    this.updateOverview();
  }

  updateOverview() {
    // Nothing needed here currently; updateOverviewStats() in main.js handles it
  }

  /**
   * Get total duration from transcript (last end timestamp)
   */
  getTotalDuration() {
    if (!this.rows || this.rows.length === 0) return 0;
    const last = this.rows[this.rows.length - 1];
    return last.end;
  }

  /**
   * Split transcript into natural 3-4 second clauses
   *
   * Groups words into clauses of approximately 3-4 seconds based on word boundaries.
   * This is a simplified version of the story-video-master:split-clauses skill.
   */
  splitIntoClauses(sceneMapData) {
    if (!this.rows || this.rows.length === 0) return [];
    if (!sceneMapData) return [];

    const words = this.rows.map(r => ({
      start: r.start,
      end: r.end,
      text: r.text.trim()
    })).filter(w => w.text.length > 0);

    if (words.length === 0) return [];

    this.clauses = [];
    let currentStart = words[0].start;
    let currentEnd = words[0].end;
    let currentText = words[0].text;

    for (let i = 1; i < words.length; i++) {
      const word = words[i];

      // If adding this word would exceed 4 seconds from the start of the clause
      if (word.start - currentStart > 4.0) {
        // Finalize current clause
        this.clauses.push({
          id: `C${this.clauses.length + 1}`.padStart(3, '0'),
          start: currentStart,
          end: currentEnd,
          narration: currentText,
          duration: currentEnd - currentStart
        });

        // Start new clause at this word
        currentStart = word.start;
        currentEnd = word.end;
        currentText = word.text;
      } else {
        // Add to current clause
        currentEnd = word.end;
        currentText += ' ' + word.text;
      }
    }

    // Don't forget the last clause
    this.clauses.push({
      id: `C${this.clauses.length + 1}`.padStart(3, '0'),
      start: currentStart,
      end: currentEnd,
      narration: currentText,
      duration: currentEnd - currentStart
    });

    return this.clauses;
  }

  /**
   * Match transcript clauses to scene map shots
   *
   * Returns an array matching each scene map shot to its transcript clause(s)
   */
  matchToShots(sceneMapData) {
    if (!this.clauses || !sceneMapData) return [];

    const shots = sceneMapData.shots || [];
    const matches = [];

    // For each shot, find the transcript clause(s) that overlap in time
    shots.forEach(shot => {
      const matchedClauses = this.clauses.filter(clause => {
        // Check overlap: clauses that intersect with the shot's time range
        return !(clause.end <= shot.start || clause.start >= shot.end);
      });

      matches.push({
        shotId: shot.id,
        shotStart: shot.start,
        shotEnd: shot.end,
        matchedClauses
      });
    });

    return matches;
  }

  toJSON() {
    return JSON.stringify({ rows: this.rows }, null, 2);
  }

  getSummaryHTML() {
    if (!this.rows || this.rows.length === 0) return 'No transcript loaded.';

    const totalDur = this.getTotalDuration().toFixed(2);
    const wordCount = this.rows.reduce((sum, r) => sum + r.text.split(/\s+/).filter(w => w).length, 0);

    return `
      <div style="font-size: 0.85rem;">
        <strong>Word count:</strong> ${wordCount}<br>
        <strong>Total duration:</strong> ${totalDur}s<br>
        <strong>Words/second:</strong> ${(wordCount / Math.max(1, totalDur)).toFixed(1)}
      </div>
    `;
  }
}

// Export for use by main.js
window.Transcript = Transcript;