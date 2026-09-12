import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";
import "./setup-network";

HTMLElement.prototype.scrollIntoView = vi.fn();
// jsdom has no pointer capture; actual popup interaction is covered in Chromium.
HTMLElement.prototype.hasPointerCapture = () => false;

afterEach(cleanup);
