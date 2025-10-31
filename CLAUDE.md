# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

NFL Pick'em is a Rails 8.1 application for running an NFL weekly pick'em pool. Users receive personalized submission links via Discord DMs, submit their picks through a web form, and receive standings updates as games complete. The app uses JWT tokens for authentication, ESPN's API for game data, and Discord's API for messaging.

## Development Commands

### Server & Development
```bash
# Start development server and CSS watcher
bin/dev

# Start Rails console
bin/rails console

# Start Rails server only
bin/rails server

# Watch Tailwind CSS changes
bin/rails tailwindcss:watch
```

### Database
```bash
# Run migrations
bin/rails db:migrate

# Reset database (drop, create, migrate, seed)
bin/rails db:reset

# Open database console
bin/rails dbconsole --include-password
```

### Testing
```bash
# Run all tests
bin/rails test

# Run specific test file
bin/rails test test/models/submission_test.rb

# Run specific test
bin/rails test test/models/submission_test.rb:10
```

### Code Quality
```bash
# Run RuboCop linter
bundle exec rubocop

# Auto-correct RuboCop issues
bundle exec rubocop -a

# Run Brakeman security scanner
bundle exec brakeman

# Audit gems for security vulnerabilities
bundle exec bundle-audit check --update
```

### Background Jobs
```bash
# Run jobs worker (processes Solid Queue jobs)
bin/jobs

# Rails console commands for job management
SolidQueue::Job.all                          # View all jobs
SolidQueue::Job.clear_finished_in_batches    # Clear completed jobs
```

## Deployment (Kamal)

This app deploys to a VPS using Kamal:

```bash
# Deploy application
bin/kamal deploy

# Access production console
bin/kamal console

# Access production shell
bin/kamal shell

# View logs
bin/kamal logs

# Database console
bin/kamal dbc

# Redeploy (faster, doesn't rebuild)
bin/kamal redeploy
```

**Important**: Secrets are stored in `.kamal/secrets` (gitignored). Deploy configuration is in `config/deploy.yml`.

## Application Architecture

### Core Data Flow

1. **User Sync**: Discord bot fetches guild members and syncs to `users` table
2. **Submission Link Delivery**: `DeliverSubmissionLinksJob` sends personalized JWT-authenticated URLs via Discord DM (Tuesdays 9am)
3. **Pick Submission**: Users access their link, view ESPN games for the week, submit picks and Monday Night Football tiebreaker
4. **Scoring**: `DeliverStandingsJob` polls ESPN API during game times (Thu/Sun/Mon), calculates standings, sends updates to Discord
5. **Hash Verification**: `DeliverHashesJob` sends SHA256 hashes of all submissions for transparency

### Key Services

**EspnScoreboard** (`app/services/espn_scoreboard.rb`)
- Fetches NFL game data from ESPN API
- Provides game status, scores, winners, and timing information
- Central time zone conversion for game times
- Used by both submission validation and scoring

**ScoringService** (`app/services/scoring_service.rb`)
- Calculates correct picks by comparing submissions to ESPN results
- Determines contenders (anyone who can mathematically win)
- Applies tiebreaker (Monday Night Football total score) when needed
- Returns sorted standings with winner/contender flags

**DiscordService** (`app/services/discord_service.rb`)
- Wraps Discord API v10 for bot operations
- Handles DM creation and message sending
- Uses ERB templates from `app/views/discord_messages/`
- Requires bot token from Rails credentials

**JwtService** (`app/services/jwt_service.rb`)
- Generates week-specific tokens for submission URLs
- Tokens include user_id, username, and week
- Submission tokens valid for 365 days
- Controller uses `JwtService.verify(token)` to authenticate

### Models

**Submission** (`app/models/submission.rb`)
- Stores picks as JSON hash: `{ competition_id => selected_team_id }`
- Unique constraint on `user_id + week`
- `#summary` generates human-readable pick list
- `#hash` creates SHA256 digest for verification

**User** (`app/models/user.rb`)
- Linked to Discord via `discord_user_id` and `discord_username`
- `#weekly_token(week)` generates JWT for submission URLs

### Background Jobs (Solid Queue)

Jobs are configured in `config/recurring.yml` with cron schedules:

- **DeliverSubmissionLinksJob**: Tuesday 9am - sends submission links to all users
- **ScheduleHashDeliveryJob**: Thursday 9am - schedules hash delivery before games start
- **DeliverHashesJob**: Runs after hash scheduling - sends submission hashes
- **DeliverStandingsJob**: Runs every 15 minutes during game windows (Thu 9pm-11pm, Sun 3pm-11pm, Mon 9pm-11pm)

The `job` server role in Kamal runs `bin/jobs` which processes the Solid Queue.

### Pick Submission Flow

1. User clicks JWT link from Discord DM
2. `SubmissionsController#new` verifies token and loads week's games via `EspnScoreboard`
3. Form displays games with radio buttons for home/away team selection
4. On submit, `ScoringService.filter_valid_picks` removes picks for started games
5. Submission saved with filtered picks + tiebreaker

### Standings Calculation

The `ScoringService#standings` method:
1. Counts correct picks for each submission by comparing to `EspnScoreboard#results`
2. Identifies leader(s) and calculates who can catch up based on remaining games
3. Marks submissions as "contenders" if mathematically alive
4. Determines winner(s) when only one contender remains OR all games complete + tiebreaker applied

### Discord Message Templates

Templates in `app/views/discord_messages/`:
- `submission_link.text.erb` - Weekly pick submission link
- `standings.text.erb` - Current standings with correct picks and contenders
- `hashes.text.erb` - SHA256 hashes of all submissions for verification

## Configuration & Secrets

**Rails Credentials** (edit with `bin/rails credentials:edit`):
- `discord.bot_token` - Discord bot authentication
- `secret_key_base` - JWT signing key

**Kamal Secrets** (`.kamal/secrets`, gitignored):
- `KAMAL_REGISTRY_PASSWORD` - Docker registry password
- `RAILS_MASTER_KEY` - Rails credentials encryption key

## Important Patterns

### ESPN API Integration
- Always use `EspnScoreboard` service, never call ESPN API directly
- Game status values: `"STATUS_SCHEDULED"`, `"STATUS_IN_PROGRESS"`, `"STATUS_FINAL"`
- Competition IDs are strings from ESPN and used as keys in submission picks
- Times are converted from UTC to Central timezone

### JWT Authentication
- Tokens are week-specific and embedded in URLs
- Use `JwtService.verify(token)` in controllers to authenticate
- Failed verification returns `nil`, not an exception
- User identity comes from JWT payload, not session

### Discord Bot Operations
- All messaging goes through `DiscordService`
- Use `render_message(template, locals)` for formatted messages
- DM sending is two-step: create channel, then send message
- Bot token must have proper intents enabled in Discord Developer Portal

### Job Scheduling
- Recurring jobs defined in `config/recurring.yml`
- Use cron syntax for complex schedules (e.g., `'*/15 21-23 * * 4'` for every 15 min, 9pm-11pm on Thursdays)
- Jobs should be idempotent - safe to run multiple times
- Check game state before sending messages to avoid spam

## UI Design
The UI design is described/defined by @DESIGN_SYSTEM.md