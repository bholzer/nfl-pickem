# This file is auto-generated from the current state of the database. Instead
# of editing this file, please use the migrations feature of Active Record to
# incrementally modify your database, and then regenerate this schema definition.
#
# This file is the source Rails uses to define your schema when running `bin/rails
# db:schema:load`. When creating a new database, `bin/rails db:schema:load` tends to
# be faster and is potentially less error prone than running all of your
# migrations from scratch. Old migrations may fail to apply correctly if those
# migrations use external dependencies or application code.
#
# It's strongly recommended that you check this file into your version control system.

ActiveRecord::Schema[8.1].define(version: 2025_10_25_003128) do
  create_table "submissions", force: :cascade do |t|
    t.datetime "created_at", null: false
    t.json "picks", default: {}, null: false
    t.integer "tiebreaker", null: false
    t.datetime "updated_at", null: false
    t.integer "user_id", null: false
    t.integer "week", null: false
    t.index ["user_id", "week"], name: "index_submissions_on_user_id_and_week", unique: true
    t.index ["user_id"], name: "index_submissions_on_user_id"
  end

  create_table "users", force: :cascade do |t|
    t.datetime "created_at", null: false
    t.string "discord_user_id"
    t.string "discord_username"
    t.datetime "updated_at", null: false
    t.index ["discord_user_id"], name: "index_users_on_discord_user_id", unique: true
  end

  add_foreign_key "submissions", "users"
end
