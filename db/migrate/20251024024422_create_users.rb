class CreateUsers < ActiveRecord::Migration[8.1]
  def change
    create_table :users do |t|
      t.string :discord_user_id
      t.string :discord_username

      t.timestamps
    end
    add_index :users, :discord_user_id, unique: true
  end
end
