import GUI from 'lil-gui';
import { applyRoadLayout, type CityParams, type RoadLayout } from '../core/params.js';
import type { DebugOverlay, OverlayLayer } from './DebugOverlay.js';
import type { Environment } from './Environment.js';
import type { MaterialLibrary } from '../material/materials.js';
import type { Controls } from './Controls.js';
import type { CityMeshResult } from '../build/CityMesh.js';

/**
 * The debug UI is not a nicety for a generator like this: most of the work is
 * tuning numbers, and judging subdivision quality from finished buildings is
 * impossible — hence the overlay toggles.
 */
export interface DebugUIOptions {
  params: CityParams;
  regenerate: () => void;
  overlay: DebugOverlay;
  environment: Environment;
  materials: MaterialLibrary;
  controls: Controls;
  getStats: () => CityMeshResult['stats'] | null;
}

const OVERLAY_LAYERS: [OverlayLayer, string][] = [
  ['roads', '道路グラフ'],
  ['blocks', '街区'],
  ['lots', '敷地'],
  ['frontage', '接道矢印'],
  ['buildable', '建築可能領域'],
  ['footprints', 'フットプリント'],
  ['flagPoles', '旗竿地の竿'],
];

export function createDebugUI(opts: DebugUIOptions): GUI {
  const { params, regenerate, overlay, environment, materials, controls } = opts;
  const gui = new GUI({ title: '都市生成パラメータ', width: 330 });

  const actions = {
    seed: params.seed,
    randomSeed: () => {
      const words = ['sakura', 'kaede', 'hinode', 'midori', 'asagao', 'yanagi', 'tsubaki'];
      params.seed = `${words[Math.floor(Math.random() * words.length)]}-${Math.floor(Math.random() * 900 + 100)}`;
      actions.seed = params.seed;
      gui.controllersRecursive().forEach((c) => c.updateDisplay());
      regenerate();
    },
    regenerate: () => regenerate(),
    walkMode: () => controls.setMode('walk'),
  };

  gui.add(actions, 'seed').name('シード').onFinishChange((v: string) => {
    params.seed = v;
    regenerate();
  });
  gui.add(actions, 'regenerate').name('再生成');
  gui.add(actions, 'randomSeed').name('ランダムシード');
  gui.add(actions, 'walkMode').name('歩行モード (W)');

  // --- Overlays ------------------------------------------------------------
  const fOverlay = gui.addFolder('デバッグ表示').close();
  const overlayState: Record<string, boolean> = {};
  for (const [layer, label] of OVERLAY_LAYERS) {
    overlayState[layer] = false;
    fOverlay.add(overlayState, layer).name(label).onChange((v: boolean) => overlay.setEnabled(layer, v));
  }

  // --- Roads ---------------------------------------------------------------
  const fRoads = gui.addFolder('道路').close();
  fRoads
    .add(params.roads, 'layout', { '有機的（歪んだ格子）': 'warped', '単純な格子＋斜め': 'grid' })
    .name('街路のレイアウト')
    .onChange((v: RoadLayout) => {
      // A layout change moves several parameters at once, so refresh the
      // sliders before regenerating or they show stale values.
      applyRoadLayout(params.roads, v);
      gui.controllersRecursive().forEach((c) => c.updateDisplay());
      regenerate();
    });
  fRoads.add(params.roads, 'diagonalCount', 0, 4, 1).name('斜め道路の本数');
  fRoads.add(params.roads, 'extent', 120, 600, 10).name('街の広さ');
  fRoads.add(params.roads, 'localSpacing', 25, 90, 1).name('区画街路の間隔');
  fRoads.add(params.roads, 'gridSpacingVariation', 0, 0.5, 0.01).name('格子間隔の変動(格子のみ)');
  fRoads.add(params.roads, 'warpAmplitude1', 0, 40, 1).name('歪み(大)');
  fRoads.add(params.roads, 'warpAmplitude2', 0, 15, 0.5).name('歪み(小)');
  fRoads.add(params.roads, 'deleteFraction', 0, 0.45, 0.01).name('街路の間引き率');
  fRoads.add(params.roads, 'deadEndFraction', 0, 0.4, 0.01).name('行き止まり率');
  fRoads.add(params.roads, 'jogFraction', 0, 0.5, 0.01).name('食い違い交差率');
  fRoads.add(params.roads, 'arterialCount', 0, 4, 1).name('幹線道路の本数');

  // --- Lots ----------------------------------------------------------------
  const fLots = gui.addFolder('敷地分割').close();
  fLots.add(params.lots, 'minLotArea', 40, 160, 2).name('最小面積');
  fLots.add(params.lots, 'maxLotArea', 150, 900, 10).name('最大面積');
  fLots.add(params.lots, 'widthMean', 5, 24, 0.5).name('平均間口');
  fLots.add(params.lots, 'depthMean', 8, 30, 0.5).name('平均奥行');
  fLots.add(params.lots, 'cutAngleJitter', 0, 15, 0.5).name('境界の傾き(度)');
  fLots.add(params.lots, 'flagLotChance', 0, 1, 0.05).name('旗竿地の発生率');
  fLots.add(params.lots, 'minFrontage', 2, 8, 0.1).name('最小間口(接道)');

  // --- Zoning --------------------------------------------------------------
  const fZone = gui.addFolder('用途配分').close();
  fZone.add(params.zoning, 'mansionMinArea', 200, 900, 10).name('マンション最小面積');
  fZone.add(params.zoning, 'mansionMinUrbanity', 0, 1, 0.02).name('マンション都市度');
  fZone.add(params.zoning, 'apartMinArea', 100, 400, 5).name('アパート最小面積');
  fZone.add(params.zoning, 'stationRadius', 200, 1400, 20).name('駅の影響半径');
  fZone.add(params.zoning, 'clusterCutChance', 0, 0.8, 0.02).name('分譲地の分断率');

  // --- Buildings -----------------------------------------------------------
  const fBuild = gui.addFolder('建物').close();
  fBuild.add(params.buildings, 'module', 0.5, 1.5, 0.01).name('モジュール(半間)');
  fBuild.add(params.buildings, 'frontSetback', 0, 4, 0.1).name('正面セットバック');
  fBuild.add(params.buildings, 'sideSetback', 0.2, 2, 0.1).name('側面セットバック');
  fBuild.add(params.buildings, 'footprintFill', 0.5, 1.0, 0.01).name('建築可能領域の充填率');
  fBuild.add(params.buildings, 'houseCoverage', 0.2, 0.9, 0.02).name('建ぺい率(戸建)');
  fBuild.add(params.buildings, 'carPadWidth', 2.2, 6, 0.1).name('駐車スペースの幅');
  fBuild.add(params.buildings, 'carPadDepth', 3, 7, 0.1).name('駐車スペースの奥行');
  fBuild.add(params.buildings, 'houseFar', 0.4, 2.5, 0.05).name('容積率(戸建)');
  fBuild.add(params.buildings, 'mansionFar', 1, 6, 0.1).name('容積率(マンション)');
  fBuild.add(params.buildings, 'houseHeightLimit', 6, 20, 0.5).name('絶対高さ制限(低層)');
  fBuild.add(params.buildings, 'northSlantSlope', 0.5, 3, 0.05).name('北側斜線の勾配');
  fBuild.add(params.buildings, 'conformIrregular').name('変形地は敷地なりに');
  fBuild.add(params.buildings, 'conformFillThreshold', 0.3, 0.95, 0.01).name('敷地なり切替の閾値');
  fBuild.add(params.buildings, 'conformCornerAngle', 20, 90, 1).name('隅切りする角度(度)');
  fBuild.add(params.buildings, 'conformCornerCut', 0, 3, 0.1).name('隅切りの長さ(m)');
  fBuild.add(params.buildings, 'mirrorChance', 0, 1, 0.05).name('ミラーリング率');
  fBuild.add(params.buildings, 'orientationJitter', 0, 8, 0.1).name('向きのばらつき(度)');
  fBuild.add(params.buildings, 'bayAlignChance', 0, 1, 0.05).name('上下階の開口を揃える');

  // --- Props ---------------------------------------------------------------
  const fProps = gui.addFolder('付帯要素').close();
  fProps.add(params.props, 'fences').name('塀・フェンス');
  fProps.add(params.props, 'parking').name('駐車場・カーポート');
  fProps.add(params.props, 'gates').name('門柱・郵便受け');
  fProps.add(params.props, 'vegetation').name('庭木・植木鉢');
  fProps.add(params.props, 'carChance', 0, 1, 0.05).name('駐車率');
  fProps.add(params.props, 'carportChance', 0, 1, 0.05).name('カーポート率');

  // --- Render --------------------------------------------------------------
  const fRender = gui.addFolder('描画');
  fRender.add(params.render, 'timeOfDay', 6, 18, 0.1).name('時刻').onChange(() => environment.update(true));
  fRender.add(params.render, 'shadows').name('影').onChange((v: boolean) => environment.setShadowsEnabled(v));
  fRender
    .add(params.render, 'shadowMapSize', [1024, 2048, 4096, 8192])
    .name('シャドウ解像度')
    .onChange((v: number) => environment.setShadowMapSize(Number(v)));
  fRender.add(params.render, 'fog').name('フォグ').onChange(() => environment.update(true));
  fRender.add(params.render, 'fogDensity', 0, 0.008, 0.0002).name('フォグ濃度').onChange(() => environment.update(true));
  fRender.add(params.render, 'textures').name('テクスチャ').onChange((v: boolean) => materials.setTexturesEnabled(v));

  return gui;
}
