package com.example.chesswhisper;

import android.os.Bundle;
import android.view.View;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import androidx.activity.EdgeToEdge;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import androidx.lifecycle.ViewModelProvider;

import com.google.android.material.button.MaterialButton;
import com.google.android.material.textfield.TextInputEditText;

public class RegisterActivity extends AppCompatActivity {
    private TextInputEditText usernameInput;
    private TextInputEditText passwordInput;
    private TextView errorText;
    private MaterialButton submitBotton;
    private ProgressBar progressBar;
    private RegisterViewModel viewModel;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        EdgeToEdge.enable(this);
        setContentView(R.layout.activity_register);
        int base=getResources().getDimensionPixelSize(R.dimen.screen_padding);
        ViewCompat.setOnApplyWindowInsetsListener(findViewById(R.id.register), (v, insets) -> {
            Insets systemBars = insets.getInsets(WindowInsetsCompat.Type.systemBars());
            v.setPadding(
                    systemBars.left + base,
                    systemBars.top + base,
                    systemBars.right + base,
                    systemBars.bottom + base);
            return insets;
        });
        usernameInput= findViewById(R.id.usernameInput);
        passwordInput= findViewById(R.id.passwordInput);
        errorText=findViewById(R.id.errorText);
        submitBotton=findViewById(R.id.submitButton);
        progressBar=findViewById(R.id.progressBar);
        viewModel= new ViewModelProvider(this).get(RegisterViewModel.class);
        viewModel.getState().observe(this,state -> render(state));
        submitBotton.setOnClickListener(v-> viewModel.register(
                usernameInput.getText().toString(),
                passwordInput.getText().toString()
        ));
        findViewById(R.id.backButton).setOnClickListener(v -> finish());
    }
    public void render(RegisterViewModel.RegisterState state){
        if(state.status==RegisterViewModel.Status.LOADING){
            progressBar.setVisibility(View.VISIBLE);
            submitBotton.setEnabled(false);
        } else{
            progressBar.setVisibility(View.GONE);
            submitBotton.setEnabled(true);
        }
        if (state.status == RegisterViewModel.Status.ERROR && state.error != null) {
            errorText.setText(state.error.getMessage());
            errorText.setVisibility(View.VISIBLE);
        } else {
            errorText.setVisibility(View.GONE);
        }
        if (state.status == RegisterViewModel.Status.SUCCESS) {
            Toast.makeText(this, R.string.register_success, Toast.LENGTH_LONG).show();
            finish();
        }
    }
}