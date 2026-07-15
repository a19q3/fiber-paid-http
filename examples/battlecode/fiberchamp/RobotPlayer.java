package fiberchamp;

import battlecode.common.*;

public class RobotPlayer {
  static final Direction[] DIRECTIONS = {
    Direction.NORTH,
    Direction.NORTHEAST,
    Direction.EAST,
    Direction.SOUTHEAST,
    Direction.SOUTH,
    Direction.SOUTHWEST,
    Direction.WEST,
    Direction.NORTHWEST
  };

  static int turnsAlive = 0;

  public static void run(RobotController rc) throws GameActionException {
    while (true) {
      turnsAlive += 1;
      try {
        UnitType type = rc.getType();
        if (type.isTowerType()) {
          runTower(rc);
        } else if (type == UnitType.SOLDIER) {
          runSoldier(rc);
        } else if (type == UnitType.MOPPER) {
          runMopper(rc);
        } else if (type == UnitType.SPLASHER) {
          runSplasher(rc);
        }
      } catch (GameActionException error) {
        System.out.println("fiberchamp action error: " + error.getMessage());
      } catch (Exception error) {
        System.out.println("fiberchamp strategy error: " + error.getMessage());
      } finally {
        Clock.yield();
      }
    }
  }

  static void runTower(RobotController rc) throws GameActionException {
    attackWeakestEnemy(rc);

    if (rc.getRoundNum() % 180 == 0 && rc.canUpgradeTower(rc.getLocation())) {
      rc.upgradeTower(rc.getLocation());
      return;
    }

    int cycle = (rc.getRoundNum() / 9 + rc.getID()) % 10;
    UnitType next = cycle == 0
      ? UnitType.MOPPER
      : cycle == 5
        ? UnitType.SPLASHER
        : UnitType.SOLDIER;
    int start = Math.abs(rc.getID() + rc.getRoundNum()) % DIRECTIONS.length;
    for (int offset = 0; offset < DIRECTIONS.length; offset += 1) {
      MapLocation spawn = rc.getLocation().add(DIRECTIONS[(start + offset) % DIRECTIONS.length]);
      if (rc.canBuildRobot(next, spawn)) {
        rc.buildRobot(next, spawn);
        return;
      }
    }
  }

  static void runSoldier(RobotController rc) throws GameActionException {
    MapLocation refill = refillPaint(rc);
    if (refill != null && rc.getPaint() < 8 && rc.getLocation().distanceSquaredTo(refill) > 2) {
      moveToward(rc, refill);
      return;
    }
    RobotInfo enemy = weakestEnemy(rc);
    if (enemy != null && rc.canAttack(enemy.getLocation())) {
      rc.attack(enemy.getLocation());
    }

    MapLocation ruin = nearestOpenRuin(rc);
    if (ruin != null && workOnPaintTower(rc, ruin)) {
      return;
    }

    MapLocation objective = enemy != null ? enemy.getLocation() : nearestEnemyPaint(rc);
    if (objective == null) {
      objective = explorationTarget(rc, 5);
    }
    moveToward(rc, objective);
    paintCurrentTile(rc, ((rc.getLocation().x + rc.getLocation().y) & 3) == 0);
  }

  static void runMopper(RobotController rc) throws GameActionException {
    refillPaint(rc);
    RobotInfo enemy = closestEnemy(rc);
    if (enemy != null) {
      Direction toward = rc.getLocation().directionTo(enemy.getLocation());
      if (toward != Direction.CENTER && rc.canMopSwing(toward)) {
        rc.mopSwing(toward);
      } else if (rc.canAttack(enemy.getLocation())) {
        rc.attack(enemy.getLocation());
      }
      moveToward(rc, enemy.getLocation());
      return;
    }

    MapLocation enemyPaint = nearestEnemyPaint(rc);
    if (enemyPaint != null && rc.canAttack(enemyPaint)) {
      rc.attack(enemyPaint);
    }
    moveToward(rc, enemyPaint != null ? enemyPaint : explorationTarget(rc, 11));
  }

  static void runSplasher(RobotController rc) throws GameActionException {
    MapLocation refill = refillPaint(rc);
    if (refill != null && rc.getPaint() < 20 && rc.getLocation().distanceSquaredTo(refill) > 2) {
      moveToward(rc, refill);
      return;
    }
    MapLocation target = densestEnemyPaint(rc);
    RobotInfo enemy = closestEnemy(rc);
    if (target == null && enemy != null) {
      target = enemy.getLocation();
    }
    if (target != null && rc.canAttack(target)) {
      rc.attack(target);
    }
    moveToward(rc, target != null ? target : explorationTarget(rc, 17));
  }

  static boolean workOnPaintTower(RobotController rc, MapLocation ruin) throws GameActionException {
    if (rc.canCompleteTowerPattern(UnitType.LEVEL_ONE_PAINT_TOWER, ruin)) {
      rc.completeTowerPattern(UnitType.LEVEL_ONE_PAINT_TOWER, ruin);
      rc.setTimelineMarker("fiberchamp paint tower", 34, 197, 94);
      return true;
    }

    if (rc.canMarkTowerPattern(UnitType.LEVEL_ONE_PAINT_TOWER, ruin)) {
      rc.markTowerPattern(UnitType.LEVEL_ONE_PAINT_TOWER, ruin);
    }

    for (MapInfo tile : rc.senseNearbyMapInfos(ruin, 8)) {
      PaintType mark = tile.getMark();
      if (mark != PaintType.EMPTY && mark != tile.getPaint() && rc.canAttack(tile.getMapLocation())) {
        rc.attack(tile.getMapLocation(), mark == PaintType.ALLY_SECONDARY);
        return true;
      }
    }

    moveAdjacentTo(rc, ruin);
    return true;
  }

  static MapLocation nearestOpenRuin(RobotController rc) throws GameActionException {
    MapLocation origin = rc.getLocation();
    MapLocation best = null;
    int bestDistance = Integer.MAX_VALUE;
    for (MapLocation ruin : rc.senseNearbyRuins(-1)) {
      if (rc.canSenseRobotAtLocation(ruin)) {
        continue;
      }
      int distance = origin.distanceSquaredTo(ruin);
      if (distance < bestDistance) {
        best = ruin;
        bestDistance = distance;
      }
    }
    return best;
  }

  static RobotInfo weakestEnemy(RobotController rc) throws GameActionException {
    RobotInfo best = null;
    for (RobotInfo enemy : rc.senseNearbyRobots(-1, rc.getTeam().opponent())) {
      if (best == null || enemy.getHealth() < best.getHealth()) {
        best = enemy;
      }
    }
    return best;
  }

  static RobotInfo closestEnemy(RobotController rc) throws GameActionException {
    RobotInfo best = null;
    int bestDistance = Integer.MAX_VALUE;
    for (RobotInfo enemy : rc.senseNearbyRobots(-1, rc.getTeam().opponent())) {
      int distance = rc.getLocation().distanceSquaredTo(enemy.getLocation());
      if (distance < bestDistance) {
        best = enemy;
        bestDistance = distance;
      }
    }
    return best;
  }

  static void attackWeakestEnemy(RobotController rc) throws GameActionException {
    RobotInfo enemy = weakestEnemy(rc);
    if (enemy != null && rc.canAttack(enemy.getLocation())) {
      rc.attack(enemy.getLocation());
    }
  }

  static MapLocation nearestEnemyPaint(RobotController rc) {
    MapLocation origin = rc.getLocation();
    MapLocation best = null;
    int bestDistance = Integer.MAX_VALUE;
    for (MapInfo tile : rc.senseNearbyMapInfos()) {
      if (!tile.getPaint().isEnemy()) {
        continue;
      }
      int distance = origin.distanceSquaredTo(tile.getMapLocation());
      if (distance < bestDistance) {
        best = tile.getMapLocation();
        bestDistance = distance;
      }
    }
    return best;
  }

  static MapLocation densestEnemyPaint(RobotController rc) {
    MapInfo[] tiles = rc.senseNearbyMapInfos();
    MapLocation best = null;
    int bestScore = 0;
    for (MapInfo candidate : tiles) {
      if (!rc.canAttack(candidate.getMapLocation())) {
        continue;
      }
      int score = 0;
      for (MapInfo tile : tiles) {
        if (tile.getPaint().isEnemy() && candidate.getMapLocation().distanceSquaredTo(tile.getMapLocation()) <= 4) {
          score += 1;
        }
      }
      if (score > bestScore) {
        best = candidate.getMapLocation();
        bestScore = score;
      }
    }
    return best;
  }

  static void paintCurrentTile(RobotController rc, boolean secondary) throws GameActionException {
    MapLocation here = rc.getLocation();
    if (!rc.senseMapInfo(here).getPaint().isAlly() && rc.canAttack(here)) {
      rc.attack(here, secondary);
    }
  }

  static MapLocation refillPaint(RobotController rc) throws GameActionException {
    if (rc.getPaint() >= rc.getType().paintCapacity / 3) {
      return null;
    }
    RobotInfo best = null;
    int bestDistance = Integer.MAX_VALUE;
    for (RobotInfo ally : rc.senseNearbyRobots(-1, rc.getTeam())) {
      if (!ally.getType().isTowerType() || ally.getPaintAmount() <= 40) {
        continue;
      }
      int distance = rc.getLocation().distanceSquaredTo(ally.getLocation());
      if (distance < bestDistance) {
        best = ally;
        bestDistance = distance;
      }
    }
    if (best == null) {
      return null;
    }
    int requested = Math.min(rc.getType().paintCapacity - rc.getPaint(), best.getPaintAmount() - 40);
    if (requested > 0 && rc.canTransferPaint(best.getLocation(), -requested)) {
      rc.transferPaint(best.getLocation(), -requested);
    }
    return best.getLocation();
  }

  static MapLocation explorationTarget(RobotController rc, int salt) {
    int phase = Math.abs(rc.getID() * 31 + salt) % 4;
    int margin = 2;
    if (phase == 0) return new MapLocation(rc.getMapWidth() - margin - 1, rc.getMapHeight() / 2);
    if (phase == 1) return new MapLocation(margin, rc.getMapHeight() / 2);
    if (phase == 2) return new MapLocation(rc.getMapWidth() / 2, rc.getMapHeight() - margin - 1);
    return new MapLocation(rc.getMapWidth() / 2, margin);
  }

  static void moveAdjacentTo(RobotController rc, MapLocation target) throws GameActionException {
    if (rc.getLocation().distanceSquaredTo(target) <= 2) {
      return;
    }
    moveToward(rc, target);
  }

  static void moveToward(RobotController rc, MapLocation target) throws GameActionException {
    if (target == null || !rc.isMovementReady()) {
      return;
    }
    Direction direct = rc.getLocation().directionTo(target);
    Direction[] choices = {
      direct,
      direct.rotateLeft(),
      direct.rotateRight(),
      direct.rotateLeft().rotateLeft(),
      direct.rotateRight().rotateRight()
    };
    for (Direction choice : choices) {
      if (choice != Direction.CENTER && rc.canMove(choice)) {
        rc.move(choice);
        return;
      }
    }
  }
}
