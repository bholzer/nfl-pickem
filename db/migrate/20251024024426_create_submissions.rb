class CreateSubmissions < ActiveRecord::Migration[8.1]
  def change
    create_table :submissions do |t|
      t.references :user, null: false, foreign_key: true
      t.integer :week, null: false
      t.integer :tiebreaker, null: false

      t.timestamps
    end
    add_index :submissions, [:user_id, :week], unique: true
  end
end
