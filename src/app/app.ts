import { Component, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { InputNumberModule } from 'primeng/inputnumber';
import { MessageModule } from 'primeng/message';
import { ProgressBarModule } from 'primeng/progressbar';
import { TagModule } from 'primeng/tag';

type FeedbackSeverity = 'success' | 'warn' | 'info';

interface MultiplicationQuestion {
  left: number;
  right: number;
  answer: number;
}

interface FeedbackMessage {
  severity: FeedbackSeverity;
  text: string;
}

@Component({
  selector: 'app-root',
  imports: [
    FormsModule,
    ButtonModule,
    CardModule,
    InputNumberModule,
    MessageModule,
    ProgressBarModule,
    TagModule,
  ],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  readonly title = 'Einmaleins-Abenteuer';

  readonly maxFactor = signal(10);
  readonly totalRounds = signal(10);

  readonly currentRound = signal(1);
  readonly correctAnswers = signal(0);
  readonly streak = signal(0);
  readonly bestStreak = signal(0);
  readonly gameFinished = signal(false);

  readonly playerAnswer = signal<number | null>(null);
  readonly feedback = signal<FeedbackMessage | null>(null);
  readonly currentQuestion = signal<MultiplicationQuestion>(this.buildQuestion(10));

  readonly progress = computed(() => {
    if (this.gameFinished()) {
      return 100;
    }

    return Math.round(((this.currentRound() - 1) / this.totalRounds()) * 100);
  });

  readonly successRate = computed(() =>
    Math.round((this.correctAnswers() / this.totalRounds()) * 100),
  );

  submitAnswer(): void {
    if (this.gameFinished()) {
      return;
    }

    const answer = this.playerAnswer();

    if (answer === null || Number.isNaN(answer)) {
      this.feedback.set({
        severity: 'warn',
        text: 'Bitte gib zuerst eine Antwort ein.',
      });
      return;
    }

    const question = this.currentQuestion();
    const isCorrect = answer === question.answer;

    if (isCorrect) {
      this.correctAnswers.update((value) => value + 1);
      const nextStreak = this.streak() + 1;
      this.streak.set(nextStreak);
      this.bestStreak.update((value) => Math.max(value, nextStreak));

      this.feedback.set({
        severity: 'success',
        text: `Super! ${question.left} × ${question.right} = ${question.answer} ist richtig.`,
      });
    } else {
      this.streak.set(0);
      this.feedback.set({
        severity: 'warn',
        text: `Fast! ${question.left} × ${question.right} wäre ${question.answer} gewesen.`,
      });
    }

    if (this.currentRound() >= this.totalRounds()) {
      this.gameFinished.set(true);
      this.playerAnswer.set(null);
      return;
    }

    this.currentRound.update((value) => value + 1);
    this.playerAnswer.set(null);
    this.currentQuestion.set(this.buildQuestion(this.maxFactor(), question));
  }

  startNewGame(): void {
    const sanitizedMaxFactor = this.sanitize(this.maxFactor(), 10, 2, 20);
    const sanitizedRounds = this.sanitize(this.totalRounds(), 10, 3, 20);

    this.maxFactor.set(sanitizedMaxFactor);
    this.totalRounds.set(sanitizedRounds);

    this.correctAnswers.set(0);
    this.currentRound.set(1);
    this.streak.set(0);
    this.bestStreak.set(0);
    this.playerAnswer.set(null);
    this.gameFinished.set(false);
    this.currentQuestion.set(this.buildQuestion(sanitizedMaxFactor));
    this.feedback.set({
      severity: 'info',
      text: 'Neue Spielrunde gestartet. Viel Erfolg! 🚀',
    });
  }

  onMaxFactorChange(value: number | null): void {
    this.maxFactor.set(this.sanitize(value, this.maxFactor(), 2, 20));
  }

  onRoundsChange(value: number | null): void {
    this.totalRounds.set(this.sanitize(value, this.totalRounds(), 3, 20));
  }

  private buildQuestion(
    factorLimit: number,
    previousQuestion?: MultiplicationQuestion,
  ): MultiplicationQuestion {
    let left = this.randomNumber(factorLimit);
    let right = this.randomNumber(factorLimit);

    if (previousQuestion) {
      let retries = 0;
      while (
        retries < 8 &&
        left === previousQuestion.left &&
        right === previousQuestion.right
      ) {
        left = this.randomNumber(factorLimit);
        right = this.randomNumber(factorLimit);
        retries += 1;
      }
    }

    return {
      left,
      right,
      answer: left * right,
    };
  }

  private randomNumber(max: number): number {
    return Math.floor(Math.random() * max) + 1;
  }

  private sanitize(
    value: number | null,
    fallback: number,
    min: number,
    max: number,
  ): number {
    if (value === null || Number.isNaN(value)) {
      return fallback;
    }

    return this.clamp(Math.trunc(value), min, max);
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
  }
}
