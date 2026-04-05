#!/usr/bin/env node
/**
 * Consensus Calibration Script
 * Uses average of all 4 models as ground truth to measure model alignment
 */

import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { writeFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'data', 'zoom-action-items.db');

const CALIBRATION_IDS = [70, 23, 63, 71, 102, 82, 2, 5, 26, 20];
const MODELS = ['claude-opus-4-6', 'gpt-5.4', 'gemini-2.0-flash', 'gemini-3.1-pro-preview'];
const DIMENSIONS = [
  'client_sentiment', 'accountability', 'relationship_health',
  'meeting_structure', 'value_delivery', 'action_discipline', 'proactive_leadership',
  'time_utilization', 'redundancy', 'client_confusion', 'meeting_momentum', 'save_rate'
];

const TIER1 = ['client_sentiment', 'accountability', 'relationship_health'];
const TIER2 = ['meeting_structure', 'value_delivery', 'action_discipline', 'proactive_leadership'];
const TIER3 = ['time_utilization', 'redundancy', 'client_confusion', 'meeting_momentum', 'save_rate'];

function std(arr) {
  if (arr.length === 0) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  return Math.sqrt(arr.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / arr.length);
}

function pearsonCorrelation(x, y) {
  if (x.length !== y.length || x.length < 2) return null;
  const n = x.length;
  const sumX = x.reduce((a, b) => a + b, 0);
  const sumY = y.reduce((a, b) => a + b, 0);
  const sumXY = x.reduce((acc, xi, i) => acc + xi * y[i], 0);
  const sumX2 = x.reduce((acc, xi) => acc + xi * xi, 0);
  const sumY2 = y.reduce((acc, yi) => acc + yi * yi, 0);

  const numerator = n * sumXY - sumX * sumY;
  const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
  return denominator !== 0 ? numerator / denominator : 0;
}

async function main() {
  const db = new Database(DB_PATH);

  console.log('🔬 Consensus Calibration Analysis\n');
  console.log(`Models: ${MODELS.join(', ')}`);
  console.log(`Calibration Meetings: ${CALIBRATION_IDS.join(', ')}`);
  console.log(`Dimensions: ${DIMENSIONS.length}\n`);

  // Gather all model scores
  const allScores = {}; // { meetingId: { dimension: { model: score } } }
  const meetingTopics = {}; // { meetingId: topic }

  for (const meetingId of CALIBRATION_IDS) {
    allScores[meetingId] = {};
    for (const dim of DIMENSIONS) {
      allScores[meetingId][dim] = {};
    }

    // Get meeting topic
    const meeting = db.prepare('SELECT topic FROM meetings WHERE id = ?').get(meetingId);
    meetingTopics[meetingId] = meeting?.topic || `Meeting ${meetingId}`;

    // Get scores from each model
    for (const model of MODELS) {
      const eval_ = db.prepare(`
        SELECT ${DIMENSIONS.join(', ')} FROM session_evaluations
        WHERE meeting_id = ? AND model_used = ?
      `).get(meetingId, model);

      if (eval_) {
        for (const dim of DIMENSIONS) {
          if (eval_[dim] != null) {
            allScores[meetingId][dim][model] = eval_[dim];
          }
        }
      }
    }
  }

  // Compute consensus scores and store them
  console.log('📊 Computing consensus scores...\n');

  const consensusScores = {}; // { meetingId: { dimension: consensus } }
  const dimensionStats = {}; // { dimension: { consensusAvg, stdev, values: [] } }

  for (const dim of DIMENSIONS) {
    dimensionStats[dim] = { values: [], stdevs: [] };
  }

  for (const meetingId of CALIBRATION_IDS) {
    consensusScores[meetingId] = {};

    for (const dim of DIMENSIONS) {
      const modelScores = Object.values(allScores[meetingId][dim]).filter(v => v != null);

      if (modelScores.length > 0) {
        const consensus = modelScores.reduce((a, b) => a + b, 0) / modelScores.length;
        const stdev = std(modelScores);

        consensusScores[meetingId][dim] = consensus;
        dimensionStats[dim].values.push(consensus);
        dimensionStats[dim].stdevs.push(stdev);
      } else {
        consensusScores[meetingId][dim] = 3; // default
      }
    }
  }

  // Compute dimension-level stats
  for (const dim of DIMENSIONS) {
    const vals = dimensionStats[dim].values;
    const stds = dimensionStats[dim].stdevs;
    dimensionStats[dim].consensusAvg = vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 3;
    dimensionStats[dim].avgStdev = stds.length > 0 ? stds.reduce((a, b) => a + b, 0) / stds.length : 0;
  }

  // Store consensus scores in database
  console.log('💾 Storing consensus scores in database...\n');

  for (const meetingId of CALIBRATION_IDS) {
    const cs = consensusScores[meetingId];

    // Calculate tier averages
    const tier1Scores = TIER1.map(d => cs[d]);
    const tier2Scores = TIER2.map(d => cs[d]);
    const tier3Scores = TIER3.map(d => cs[d]);

    const tier1_avg = tier1Scores.reduce((a, b) => a + b, 0) / tier1Scores.length;
    const tier2_avg = tier2Scores.reduce((a, b) => a + b, 0) / tier2Scores.length;
    const tier3_avg = tier3Scores.reduce((a, b) => a + b, 0) / tier3Scores.length;
    const composite = (tier1_avg * 0.40) + (tier2_avg * 0.35) + (tier3_avg * 0.25);

    db.prepare(`
      INSERT INTO session_evaluations (
        meeting_id, model_used,
        client_sentiment, accountability, relationship_health,
        meeting_structure, value_delivery, action_discipline, proactive_leadership,
        time_utilization, redundancy, client_confusion, meeting_momentum, save_rate,
        tier1_avg, tier2_avg, tier3_avg, composite_score,
        meeting_type, coaching_notes, computed_at
      ) VALUES (
        ?, 'consensus-average',
        ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        'calibration', 'Average of 4 AI models', datetime('now')
      )
      ON CONFLICT(meeting_id, model_used) DO UPDATE SET
        client_sentiment = excluded.client_sentiment,
        accountability = excluded.accountability,
        relationship_health = excluded.relationship_health,
        meeting_structure = excluded.meeting_structure,
        value_delivery = excluded.value_delivery,
        action_discipline = excluded.action_discipline,
        proactive_leadership = excluded.proactive_leadership,
        time_utilization = excluded.time_utilization,
        redundancy = excluded.redundancy,
        client_confusion = excluded.client_confusion,
        meeting_momentum = excluded.meeting_momentum,
        save_rate = excluded.save_rate,
        tier1_avg = excluded.tier1_avg,
        tier2_avg = excluded.tier2_avg,
        tier3_avg = excluded.tier3_avg,
        composite_score = excluded.composite_score,
        computed_at = datetime('now')
    `).run(
      meetingId,
      cs.client_sentiment, cs.accountability, cs.relationship_health,
      cs.meeting_structure, cs.value_delivery, cs.action_discipline, cs.proactive_leadership,
      cs.time_utilization, cs.redundancy, cs.client_confusion, cs.meeting_momentum, cs.save_rate,
      tier1_avg, tier2_avg, tier3_avg, composite
    );
  }

  // Compute MAE and correlation for each model vs consensus
  console.log('📈 Computing model alignment metrics...\n');

  const modelResults = [];

  for (const model of MODELS) {
    const modelVec = [];
    const consensusVec = [];
    let totalAbsError = 0;
    let dataPoints = 0;
    let outlierCount = 0; // deviation >= 1.5
    const perDimMAE = {};

    for (const dim of DIMENSIONS) {
      perDimMAE[dim] = { total: 0, count: 0 };
    }

    for (const meetingId of CALIBRATION_IDS) {
      for (const dim of DIMENSIONS) {
        const modelScore = allScores[meetingId][dim][model];
        const consensusScore = consensusScores[meetingId][dim];

        if (modelScore != null && consensusScore != null) {
          const diff = Math.abs(modelScore - consensusScore);
          totalAbsError += diff;
          dataPoints++;
          modelVec.push(modelScore);
          consensusVec.push(consensusScore);
          perDimMAE[dim].total += diff;
          perDimMAE[dim].count++;

          if (diff >= 1.5) outlierCount++;
        }
      }
    }

    const mae = dataPoints > 0 ? totalAbsError / dataPoints : null;
    const correlation = pearsonCorrelation(modelVec, consensusVec);
    const outlierRate = dataPoints > 0 ? (outlierCount / dataPoints * 100) : 0;

    // Per-dimension MAE
    const dimMAE = {};
    for (const dim of DIMENSIONS) {
      const d = perDimMAE[dim];
      dimMAE[dim] = d.count > 0 ? d.total / d.count : null;
    }

    // Find closest and furthest dimensions
    const sortedDims = DIMENSIONS
      .filter(d => dimMAE[d] !== null)
      .sort((a, b) => dimMAE[a] - dimMAE[b]);

    modelResults.push({
      model,
      mae,
      correlation,
      outlierRate,
      dataPoints,
      dimMAE,
      closestDims: sortedDims.slice(0, 3),
      furthestDims: sortedDims.slice(-3).reverse()
    });
  }

  // Sort by MAE (lowest = best)
  modelResults.sort((a, b) => (a.mae || 999) - (b.mae || 999));

  // Per-meeting breakdown
  const perMeetingResults = [];

  for (const meetingId of CALIBRATION_IDS) {
    const consensusComposite = (() => {
      const cs = consensusScores[meetingId];
      const t1 = TIER1.map(d => cs[d]).reduce((a, b) => a + b, 0) / TIER1.length;
      const t2 = TIER2.map(d => cs[d]).reduce((a, b) => a + b, 0) / TIER2.length;
      const t3 = TIER3.map(d => cs[d]).reduce((a, b) => a + b, 0) / TIER3.length;
      return (t1 * 0.40) + (t2 * 0.35) + (t3 * 0.25);
    })();

    let maxDelta = 0;
    let mostDivergentModel = '';

    for (const model of MODELS) {
      let totalDiff = 0;
      let count = 0;
      for (const dim of DIMENSIONS) {
        const ms = allScores[meetingId][dim][model];
        const cs = consensusScores[meetingId][dim];
        if (ms != null && cs != null) {
          totalDiff += Math.abs(ms - cs);
          count++;
        }
      }
      const avgDiff = count > 0 ? totalDiff / count : 0;
      if (avgDiff > maxDelta) {
        maxDelta = avgDiff;
        mostDivergentModel = model;
      }
    }

    perMeetingResults.push({
      meetingId,
      topic: meetingTopics[meetingId],
      consensusComposite,
      mostDivergentModel,
      maxDelta
    });
  }

  // Dimension difficulty (sorted by avg stdev)
  const dimDifficulty = DIMENSIONS
    .map(dim => ({
      dim,
      consensusAvg: dimensionStats[dim].consensusAvg,
      avgStdev: dimensionStats[dim].avgStdev,
      closestModel: modelResults.reduce((best, m) =>
        (m.dimMAE[dim] || 999) < (best.dimMAE[dim] || 999) ? m : best
      ).model,
      furthestModel: modelResults.reduce((worst, m) =>
        (m.dimMAE[dim] || 0) > (worst.dimMAE[dim] || 0) ? m : worst
      ).model
    }))
    .sort((a, b) => b.avgStdev - a.avgStdev);

  // Generate report
  const today = new Date().toISOString().split('T')[0];
  const winner = modelResults[0];

  let report = `# Consensus Calibration Report
Date: ${today}
Method: Average of 4 models as consensus baseline

## Model Rankings (closest to consensus)
| Rank | Model | MAE vs Consensus | Correlation | Outlier Rate |
|------|-------|-----------------|-------------|--------------|
`;

  modelResults.forEach((m, i) => {
    report += `| ${i + 1} | ${m.model} | ${m.mae?.toFixed(4) || 'N/A'} | ${m.correlation?.toFixed(4) || 'N/A'} | ${m.outlierRate.toFixed(1)}% |\n`;
  });

  report += `
## Per-Dimension Agreement
| Dimension | Consensus Avg | Stdev (disagreement) | Closest Model | Furthest Model |
|-----------|--------------|---------------------|---------------|----------------|
`;

  dimDifficulty.forEach(d => {
    report += `| ${d.dim} | ${d.consensusAvg.toFixed(2)} | ${d.avgStdev.toFixed(3)} | ${d.closestModel} | ${d.furthestModel} |\n`;
  });

  report += `
## Per-Meeting Breakdown
| Meeting | Topic | Consensus Composite | Most Divergent Model | Max Delta |
|---------|-------|--------------------|--------------------|-----------|
`;

  perMeetingResults.forEach(pm => {
    const shortTopic = pm.topic.length > 40 ? pm.topic.slice(0, 40) + '...' : pm.topic;
    report += `| ${pm.meetingId} | ${shortTopic} | ${pm.consensusComposite.toFixed(2)} | ${pm.mostDivergentModel} | ${pm.maxDelta.toFixed(3)} |\n`;
  });

  report += `
## Dimension Difficulty (by inter-model stdev)
**Most Subjective (highest disagreement):**
`;

  dimDifficulty.slice(0, 4).forEach(d => {
    report += `- ${d.dim}: stdev ${d.avgStdev.toFixed(3)}\n`;
  });

  report += `
**Most Objective (highest agreement):**
`;

  dimDifficulty.slice(-4).reverse().forEach(d => {
    report += `- ${d.dim}: stdev ${d.avgStdev.toFixed(3)}\n`;
  });

  report += `
## Recommendation

**${winner.model}** is most aligned with consensus:
- MAE: ${winner.mae?.toFixed(4)} (lowest deviation from average)
- Correlation: ${winner.correlation?.toFixed(4)}
- Outlier Rate: ${winner.outlierRate.toFixed(1)}%
- Closest dimensions: ${winner.closestDims.join(', ')}
- Furthest dimensions: ${winner.furthestDims.join(', ')}

**Production Recommendation:** Use **${winner.model}** as the default evaluation model for its closest alignment with multi-model consensus.
`;

  // Save report
  const reportPath = join(__dirname, '..', 'data', 'consensus-calibration-report.md');
  writeFileSync(reportPath, report);
  console.log(`📄 Report saved to: ${reportPath}\n`);

  // Print full report
  console.log('=' .repeat(70));
  console.log(report);
  console.log('=' .repeat(70));

  db.close();
  console.log('\n✅ Consensus calibration complete!');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
