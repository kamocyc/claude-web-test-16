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
  ['contours', '等高線 (2m)'],
  ['water', '河川区域'],
  ['growth', '道路の世代'],
  ['roads', '道路グラフ'],
  ['blocks', '街区'],
  ['lots', '敷地'],
  ['frontage', '接道矢印'],
  ['buildable', '建築可能領域'],
  ['footprints', 'フットプリント'],
  ['flagPoles', '旗竿地の竿'],
  ['vacantUnsold', '空き地（未分譲・売れ残り）'],
  ['vacantUnbuildable', '空き地（建てられない）'],
  ['vacantAvoidable', '空き地（要調査）'],
  ['landUse', '用途（敷地の輪郭）'],
  ['useZones', '用途地域（地区の輪郭）'],
  ['useFill', '用途（敷地の塗り分け）'],
  ['zoneFill', '用途地域（地区の塗り分け）'],
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
    driveMode: () => controls.setMode('drive'),
  };

  gui.add(actions, 'seed').name('シード').onFinishChange((v: string) => {
    params.seed = v;
    regenerate();
  });
  // The one control this whole feature exists to expose, deliberately not
  // buried in a folder: it is what "the town grew" means from the outside.
  gui
    .add(params.roads.growth, 'steps', 2, 40, 1)
    .name('街の年齢（成長ステップ）')
    .onFinishChange(regenerate);
  gui.add(actions, 'regenerate').name('再生成');
  gui.add(actions, 'randomSeed').name('ランダムシード');
  gui.add(actions, 'walkMode').name('歩行モード (W)');
  gui.add(actions, 'driveMode').name('走行モード (C)');

  // --- Overlays ------------------------------------------------------------
  const fOverlay = gui.addFolder('デバッグ表示').close();
  const overlayState: Record<string, boolean> = {};
  for (const [layer, label] of OVERLAY_LAYERS) {
    overlayState[layer] = false;
    fOverlay.add(overlayState, layer).name(label).onChange((v: boolean) => overlay.setEnabled(layer, v));
  }

  // --- Roads ---------------------------------------------------------------
  // --- 地形 -----------------------------------------------------------------
  const fTerrain = gui.addFolder('地形').close();
  fTerrain.add(params.terrain, 'enabled').name('地形を使う');
  fTerrain.add(params.terrain, 'relief', 0, 60, 1).name('起伏の大きさ(m)');
  fTerrain.add(params.terrain, 'hillScale', 120, 600, 10).name('丘の大きさ(m)');
  fTerrain.add(params.terrain, 'tiltGrade', 0, 0.05, 0.002).name('全体の傾き');
  fTerrain.add(params.terrain, 'maxBuildSlope', 0.2, 1.5, 0.05).name('建てられる最大傾斜');
  fTerrain.add(params.terrain.river, 'enabled').name('川をつくる');
  fTerrain.add(params.terrain.river, 'width', 6, 60, 2).name('川幅(m)');
  fTerrain.add(params.terrain.river, 'valleyWidth', 40, 300, 10).name('谷の広がり(m)');
  fTerrain.add(params.terrain.river, 'bankMargin', 0, 40, 1).name('河川区域の余白(m)');
  fTerrain.add(params.terrain.terrace, 'count', 0, 4, 1).name('段丘崖の数');
  fTerrain.add(params.terrain.terrace, 'step', 1, 10, 0.5).name('段丘崖の高さ(m)');

  // --- 都市の成長 -----------------------------------------------------------
  const fGrowth = gui.addFolder('都市の成長').close();
  fGrowth.add(params.roads.growth, 'enabled').name('成長させる（切ると一発生成）');
  fGrowth.add(params.roads.growth, 'coreLotScale', 0.5, 1.4, 0.02).name('中心部の敷地の大きさ(倍)');
  fGrowth.add(params.roads.growth, 'fringeLotScale', 0.8, 2.5, 0.02).name('外縁部の敷地の大きさ(倍)');
  fGrowth.add(params.roads.growth, 'fringeVacancy', 0, 0.6, 0.02).name('新規分譲地の未分譲率');
  fGrowth.add(params.roads.growth, 'sellOutSteps', 1, 24, 1).name('完売までの年数（成長ステップ）');
  fGrowth.add(params.roads.growth, 'fullAt', 6, 48, 1).name('市街化が完了する年齢');
  fGrowth.add(params.roads.growth, 'spreadExponent', 0.3, 1.4, 0.02).name('広がりの速さ');
  fGrowth.add(params.roads.growth, 'streetsPerStep', 2, 20, 1).name('1段階あたりの道路数');
  fGrowth.add(params.roads.growth, 'cutFillWeight', 0, 3, 0.1).name('切土盛土を嫌う度合い');
  fGrowth.add(params.roads.growth, 'slopeWeight', 0, 3, 0.1).name('勾配を嫌う度合い');

  // --- 造成・擁壁 -----------------------------------------------------------
  const fPad = gui.addFolder('造成・擁壁').close();
  fPad.add(params.platform, 'enabled').name('造成する');
  fPad.add(params.platform, 'plinth', 0, 1.2, 0.05).name('道路からの立ち上がり(m)');
  fPad.add(params.platform, 'riserQuantum', 0.05, 0.5, 0.01).name('段差の刻み(m)');
  fPad.add(params.platform, 'maxRiseAboveStreet', 0, 6, 0.25).name('道路より高くできる量(m)');
  fPad.add(params.platform, 'maxCutBelowStreet', 0, 6, 0.25).name('道路より低くできる量(m)');
  fPad.add(params.platform, 'wallMin', 0.2, 2, 0.1).name('擁壁にする段差(m)');

  const fRoads = gui.addFolder('道路').close();
  fRoads
    .add(params.roads, 'layout', { '地区型（区画整理の集合）': 'district', '単純な格子＋斜め': 'grid' })
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
  fRoads.add(params.roads, 'gridSpacingVariation', 0, 0.5, 0.01).name('街区の長さの変動');
  fRoads.add(params.roads, 'collectorSpacing', 120, 320, 10).name('地区の大きさ');
  fRoads.add(params.roads, 'deleteFraction', 0, 0.45, 0.01).name('街路の間引き率');
  fRoads.add(params.roads, 'deadEndFraction', 0, 0.4, 0.01).name('行き止まり率');
  fRoads.add(params.roads, 'staggerFraction', 0, 0.6, 0.01).name('食い違い交差率');
  fRoads.add(params.roads, 'districtAxisJitter', 0, 20, 0.5).name('地区の向きのばらつき(度)');
  fRoads.add(params.roads, 'localBendAngle', 0, 10, 0.5).name('生活道路の曲がり(度)');
  fRoads.add(params.roads, 'roadClearance', 0, 6, 0.1).name('道路間の最小空き');
  fRoads.add(params.roads, 'minJunctionAngle', 15, 60, 1).name('最小交差角(度)');
  fRoads.add(params.roads, 'arterialCount', 0, 4, 1).name('幹線道路の本数');

  // --- Lots ----------------------------------------------------------------
  // The two sliders that move the street grid, and the only two that do now:
  // `city/LotModule.ts` spaces the streets at two lot depths plus the road, and
  // caps the block at a whole number of frontages. Dragging 平均奥行 does not
  // make the lots deeper inside the same blocks — it makes the blocks deeper.
  const fLots = gui.addFolder('敷地分割').close();
  fLots.add(params.lots, 'minLotArea', 8, 160, 1).name('最小面積');
  fLots.add(params.lots, 'maxLotArea', 150, 900, 10).name('最大面積');
  fLots.add(params.lots, 'widthMean', 5, 24, 0.5).name('平均間口（街区の長さを決める）');
  fLots.add(params.lots, 'depthMean', 8, 30, 0.5).name('平均奥行（街路の間隔を決める）');
  fLots.add(params.lots, 'cutAngleJitter', 0, 15, 0.5).name('境界の傾き(度)');
  fLots.add(params.lots, 'flagLotChance', 0, 1, 0.05).name('旗竿地の発生率');
  fLots.add(params.lots, 'minFrontage', 0.5, 8, 0.1).name('最小間口(接道)');
  // The real gate on a scrap: `minLotArea` alone never rejects one.
  fLots.add(params.lots, 'minInscribedRadius', 0.5, 4, 0.1).name('最小内接円の半径');

  // --- Land use ------------------------------------------------------------
  // Upstream of everything in 用途配分 below: this decides the *map*, that
  // decides what gets built under it. Changing the industrial share moves the
  // street grid — the industrial plot is a different size, and the grid is sized
  // to the plot — so these all force a full regeneration like every other slider.
  const fUse = gui.addFolder('用途地域').close();
  fUse.add(params.landUse, 'industrialShare', 0, 0.4, 0.01).name('工業地区の面積比');
  fUse.add(params.landUse, 'industrialMinStationDist', 0, 600, 10).name('駅から工業までの距離');
  fUse.add(params.landUse, 'commercialCoreRadius', 60, 400, 10).name('駅前商業の半径');
  fUse.add(params.landUse, 'neighbourhoodRadius', 100, 600, 10).name('近隣商業の広がり');
  fUse.add(params.landUse, 'quasiIndustrialRing').name('工業を準工業で囲む');

  // --- Zoning --------------------------------------------------------------
  const fZone = gui.addFolder('用途配分').close();
  fZone.add(params.zoning, 'mansionMinArea', 200, 900, 10).name('マンション最小面積');
  fZone.add(params.zoning, 'mansionMinUrbanity', 0, 1, 0.02).name('マンション都市度');
  fZone.add(params.zoning, 'apartMinArea', 100, 400, 5).name('アパート最小面積');
  fZone.add(params.zoning, 'stationRadius', 200, 1400, 20).name('駅の影響半径');
  fZone.add(params.zoning, 'clusterCutChance', 0, 0.8, 0.02).name('分譲地の分断率');
  fZone.add(params.landUse, 'commercialShare', 0.04, 0.4, 0.01).name('商業地の面積比');
  fZone.add(params.zoning, 'shophouseMaxFrontage', 5, 16, 0.5).name('店舗併用住宅の最大間口');
  fZone.add(params.zoning, 'shophouseMinUrbanity', 0, 1, 0.02).name('商店街になる都市度');
  fZone.add(params.zoning, 'zakkyoMinUrbanity', 0, 1, 0.02).name('雑居ビル都市度');
  fZone.add(params.zoning, 'konbiniMinFrontage', 8, 40, 1).name('コンビニ最小間口');
  fZone.add(params.zoning, 'konbiniPerDistrict', 0, 4, 1).name('地区あたりコンビニ数');
  fZone.add(params.zoning, 'factoryMinArea', 300, 3000, 50).name('工場の最小面積');
  fZone.add(params.zoning, 'warehouseMinArea', 600, 4000, 50).name('倉庫の最小面積');

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
  fBuild.add(params.buildings, 'zakkyoFar', 1, 8, 0.1).name('容積率(雑居ビル)');
  fBuild.add(params.buildings, 'zakkyoHeightLimit', 12, 45, 1).name('絶対高さ制限(商業)');
  fBuild.add(params.buildings, 'industrialHeightLimit', 8, 30, 0.5).name('絶対高さ制限(工業)');
  fBuild.add(params.buildings, 'konbiniCoverage', 0.15, 0.7, 0.01).name('建ぺい率(コンビニ)');
  fBuild.add(params.buildings, 'awningDepth', 0, 2.5, 0.1).name('庇の出');
  fBuild.add(params.buildings, 'signBandHeight', 0, 1.6, 0.05).name('看板帯の高さ');

  // The single most visible setting in the generator: what the town reads as
  // from the air. Parts, not percentages — the sampler renormalises.
  const fRoofHue = fBuild.addFolder('屋根の色の配合').close();
  const HUES: [keyof typeof params.buildings.roofHueMix, string][] = [
    ['redBrown', '赤錆茶・赤茶系'],
    ['navy', '紺・コバルト系'],
    ['grey', '銀黒・ガルバ黒系'],
    ['brown', '茶系'],
    ['green', '青緑・いぶし緑系'],
  ];
  for (const [key, label] of HUES) {
    fRoofHue.add(params.buildings.roofHueMix, key, 0, 60, 1).name(label);
  }

  // --- Props ---------------------------------------------------------------
  const fProps = gui.addFolder('付帯要素').close();
  fProps.add(params.props, 'fences').name('塀・フェンス');
  fProps.add(params.props, 'parking').name('駐車場・カーポート');
  fProps.add(params.props, 'gates').name('門柱・郵便受け');
  fProps.add(params.props, 'vegetation').name('庭木・植木鉢');
  fProps.add(params.props, 'signage').name('看板・のぼり・自販機');
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
