import { TestBed } from '@angular/core/testing';
import { App } from './app';

describe('App', () => {
  const createApp = () => {
    const fixture = TestBed.createComponent(App);
    return fixture.componentInstance;
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
    }).compileComponents();
  });

  it('should create the app', () => {
    const app = createApp();
    expect(app).toBeTruthy();
  });

  it('should evaluate a correct answer and move to the next round (happy path)', () => {
    const app = createApp();

    app.currentQuestion.set({ left: 3, right: 4, answer: 12 });
    app.playerAnswer.set(12);

    app.submitAnswer();

    expect(app.correctAnswers()).toBe(1);
    expect(app.streak()).toBe(1);
    expect(app.currentRound()).toBe(2);
    expect(app.playerAnswer()).toBeNull();
    expect(app.feedback()?.severity).toBe('success');
  });

  it('should keep round state and show warning when answer is missing (edge case)', () => {
    const app = createApp();

    app.playerAnswer.set(null);
    app.submitAnswer();

    expect(app.correctAnswers()).toBe(0);
    expect(app.currentRound()).toBe(1);
    expect(app.feedback()?.severity).toBe('warn');
  });

  it('should finish the game after the final round', () => {
    const app = createApp();

    app.totalRounds.set(1);
    app.currentRound.set(1);
    app.currentQuestion.set({ left: 2, right: 5, answer: 10 });
    app.playerAnswer.set(10);

    app.submitAnswer();

    expect(app.gameFinished()).toBe(true);
    expect(app.progress()).toBe(100);
  });
});
