package arena_baseline;

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

  static int age = 0;

  public static void run(RobotController rc) throws GameActionException {
    while (true) {
      age += 1;
      try {
        if (rc.getType().isTowerType()) {
          runTower(rc);
        } else if (rc.getType() == UnitType.MOPPER) {
          runMopper(rc);
        } else if (rc.getType() == UnitType.SPLASHER) {
          runSplasher(rc);
        } else {
          runSoldier(rc);
        }
      } catch (Exception error) {
        System.out.println("arena baseline error: " + error.getMessage());
      } finally {
        Clock.yield();
      }
    }
  }

  static void runTower(RobotController rc) throws GameActionException {
    RobotInfo[] enemies = rc.senseNearbyRobots(-1, rc.getTeam().opponent());
    for (RobotInfo enemy : enemies) {
      if (rc.canAttack(enemy.getLocation())) {
        rc.attack(enemy.getLocation());
        break;
      }
    }

    int cycle = (rc.getRoundNum() / 12 + rc.getID()) % 8;
    UnitType next = cycle == 1 || cycle == 3 || cycle == 5
      ? UnitType.MOPPER
      : cycle == 7
        ? UnitType.SPLASHER
        : UnitType.SOLDIER;
    int start = Math.abs(rc.getRoundNum() + rc.getID()) % DIRECTIONS.length;
    for (int i = 0; i < DIRECTIONS.length; i += 1) {
      MapLocation spawn = rc.getLocation().add(DIRECTIONS[(start + i) % DIRECTIONS.length]);
      if (rc.canBuildRobot(next, spawn)) {
        rc.buildRobot(next, spawn);
        return;
      }
    }
  }

  static void runSoldier(RobotController rc) throws GameActionException {
    RobotInfo enemy = firstEnemy(rc);
    if (enemy != null && rc.canAttack(enemy.getLocation())) {
      rc.attack(enemy.getLocation());
    }

    MapLocation ruin = firstOpenRuin(rc);
    if (ruin != null) {
      if (rc.canCompleteTowerPattern(UnitType.LEVEL_ONE_MONEY_TOWER, ruin)) {
        rc.completeTowerPattern(UnitType.LEVEL_ONE_MONEY_TOWER, ruin);
        return;
      }
      if (rc.canMarkTowerPattern(UnitType.LEVEL_ONE_MONEY_TOWER, ruin)) {
        rc.markTowerPattern(UnitType.LEVEL_ONE_MONEY_TOWER, ruin);
      }
      for (MapInfo tile : rc.senseNearbyMapInfos(ruin, 8)) {
        PaintType mark = tile.getMark();
        if (mark != PaintType.EMPTY && mark != tile.getPaint() && rc.canAttack(tile.getMapLocation())) {
          rc.attack(tile.getMapLocation(), mark == PaintType.ALLY_SECONDARY);
          return;
        }
      }
      moveToward(rc, ruin);
    } else if (enemy != null) {
      moveToward(rc, enemy.getLocation());
    } else {
      sweep(rc);
    }

    MapLocation here = rc.getLocation();
    if (!rc.senseMapInfo(here).getPaint().isAlly() && rc.canAttack(here)) {
      rc.attack(here, (rc.getID() + rc.getRoundNum()) % 5 == 0);
    }
  }

  static void runMopper(RobotController rc) throws GameActionException {
    RobotInfo enemy = firstEnemy(rc);
    if (enemy != null) {
      Direction direction = rc.getLocation().directionTo(enemy.getLocation());
      if (direction != Direction.CENTER && rc.canMopSwing(direction)) {
        rc.mopSwing(direction);
      } else if (rc.canAttack(enemy.getLocation())) {
        rc.attack(enemy.getLocation());
      }
      moveToward(rc, enemy.getLocation());
      return;
    }

    MapLocation paint = firstEnemyPaint(rc);
    if (paint != null && rc.canAttack(paint)) {
      rc.attack(paint);
    }
    if (paint != null) moveToward(rc, paint); else sweep(rc);
  }

  static void runSplasher(RobotController rc) throws GameActionException {
    MapLocation paint = firstEnemyPaint(rc);
    if (paint != null && rc.canAttack(paint)) {
      rc.attack(paint);
    }
    if (paint != null) moveToward(rc, paint); else sweep(rc);
  }

  static RobotInfo firstEnemy(RobotController rc) throws GameActionException {
    RobotInfo[] enemies = rc.senseNearbyRobots(-1, rc.getTeam().opponent());
    return enemies.length == 0 ? null : enemies[0];
  }

  static MapLocation firstOpenRuin(RobotController rc) throws GameActionException {
    for (MapLocation ruin : rc.senseNearbyRuins(-1)) {
      if (!rc.canSenseRobotAtLocation(ruin)) {
        return ruin;
      }
    }
    return null;
  }

  static MapLocation firstEnemyPaint(RobotController rc) {
    for (MapInfo tile : rc.senseNearbyMapInfos()) {
      if (tile.getPaint().isEnemy()) {
        return tile.getMapLocation();
      }
    }
    return null;
  }

  static void sweep(RobotController rc) throws GameActionException {
    int index = Math.abs(rc.getID() + age / 7) % DIRECTIONS.length;
    for (int i = 0; i < DIRECTIONS.length; i += 1) {
      Direction direction = DIRECTIONS[(index + i) % DIRECTIONS.length];
      if (rc.canMove(direction)) {
        rc.move(direction);
        return;
      }
    }
  }

  static void moveToward(RobotController rc, MapLocation target) throws GameActionException {
    if (target == null || !rc.isMovementReady()) {
      return;
    }
    Direction direct = rc.getLocation().directionTo(target);
    Direction[] choices = { direct, direct.rotateLeft(), direct.rotateRight() };
    for (Direction direction : choices) {
      if (direction != Direction.CENTER && rc.canMove(direction)) {
        rc.move(direction);
        return;
      }
    }
    sweep(rc);
  }
}
