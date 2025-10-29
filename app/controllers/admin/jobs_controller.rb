class Admin::JobsController < AdminController
  AVAILABLE_JOBS = {
    "deliver_submission_links" => {
      name: "Deliver Submission Links",
      description: "Send submission links to all users via Discord DM",
      job_class: "DeliverSubmissionLinksJob",
      requires_week: true
    },
    "deliver_standings" => {
      name: "Deliver Standings",
      description: "Calculate and send current standings to Discord",
      job_class: "DeliverStandingsJob",
      requires_week: true
    },
    "deliver_hashes" => {
      name: "Deliver Hashes",
      description: "Send SHA256 hashes of all submissions for verification",
      job_class: "DeliverHashesJob",
      requires_week: true
    },
    "schedule_hash_delivery" => {
      name: "Schedule Hash Delivery",
      description: "Schedule the hash delivery job for later",
      job_class: "ScheduleHashDeliveryJob",
      requires_week: true
    }
  }.freeze

  def index
    @available_jobs = AVAILABLE_JOBS
    @recent_jobs = SolidQueue::Job.order(created_at: :desc).limit(20)
  end

  def create
    job_type = params[:job_type]
    job_config = AVAILABLE_JOBS[job_type]

    unless job_config
      redirect_to admin_jobs_path, alert: "Invalid job type"
      return
    end

    week = params[:week] || EspnScoreboard.current_week

    # Enqueue the job
    job_class = job_config[:job_class].constantize
    job_class.perform_later(week: week)

    redirect_to admin_jobs_path, notice: "#{job_config[:name]} enqueued for week #{week}"
  end
end
