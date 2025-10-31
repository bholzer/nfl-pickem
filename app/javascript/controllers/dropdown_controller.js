import { Controller } from "@hotwired/stimulus"

// Connects to data-controller="dropdown"
export default class extends Controller {
  static targets = ["menu"]

  connect() {
    // Close dropdown when clicking outside
    this.boundClose = this.closeOnClickOutside.bind(this)
  }

  toggle(event) {
    event.stopPropagation()
    this.menuTarget.classList.toggle("hidden")

    if (!this.menuTarget.classList.contains("hidden")) {
      // Add click listener to close when clicking outside
      setTimeout(() => {
        document.addEventListener("click", this.boundClose)
      }, 0)
    } else {
      document.removeEventListener("click", this.boundClose)
    }
  }

  close() {
    this.menuTarget.classList.add("hidden")
    document.removeEventListener("click", this.boundClose)
  }

  closeOnClickOutside(event) {
    if (!this.element.contains(event.target)) {
      this.close()
    }
  }

  disconnect() {
    document.removeEventListener("click", this.boundClose)
  }
}
