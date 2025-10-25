class CreatePicks < ActiveRecord::Migration[8.1]
  def change
    create_table :picks do |t|
      t.references :submission, null: false, foreign_key: true
      t.string :competition_id, null: false
      t.string :selected_team_id, null: false

      t.timestamps
    end
  end
end
