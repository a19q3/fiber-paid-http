# Battlecode demo bots

These Java bots are original MIT-licensed demo strategies for the Fiber Paid
HTTP tournament lane. They are intentionally understandable rather than
tournament-grade:

- `fiberchamp/RobotPlayer.java` is the entrant file selected in the browser and
  uploaded to the evidence API.
- `arena_baseline/RobotPlayer.java` is the server-controlled opponent. Its exact
  SHA-256 is committed before ticket payment and checked again before a match.

The strategies use the public Battlecode 2025 3.1.0 API and game rules. They do
not copy the AGPL-3.0 official scaffold player or third-party tournament bots.

References:

- https://releases.battlecode.org/specs/battlecode25/3.1.0/specs.pdf
- https://releases.battlecode.org/javadoc/battlecode25/3.1.0/
- https://github.com/battlecode/battlecode25-scaffold
