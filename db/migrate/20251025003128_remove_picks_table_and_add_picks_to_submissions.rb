class RemovePicksTableAndAddPicksToSubmissions < ActiveRecord::Migration[8.1]
  def change
    drop_table :picks

    # Add JSON column for picks: { "competition_id" => "team_id", ... }
    add_column :submissions, :picks, :json, default: {}, null: false
  end
end
