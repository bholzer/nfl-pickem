import { Controller } from "@hotwired/stimulus"

// Connects to data-controller="mobile-menu"
export default class extends Controller {
  static targets = ["menu", "icon", "closeIcon"]

  toggle() {
    this.menuTarget.classList.toggle("hidden")
    this.iconTarget.classList.toggle("hidden")
    this.iconTarget.classList.toggle("block")
    this.closeIconTarget.classList.toggle("hidden")
    this.closeIconTarget.classList.toggle("block")
  }

  close() {
    this.menuTarget.classList.add("hidden")
    this.iconTarget.classList.remove("hidden")
    this.iconTarget.classList.add("block")
    this.closeIconTarget.classList.add("hidden")
    this.closeIconTarget.classList.remove("block")
  }
}
